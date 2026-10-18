#!/usr/bin/env python3
"""Local web server for auditable multimodal model benchmarking.

Uses only Python's standard library. API keys live in the request process memory,
are never logged and are never written to disk.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import shutil
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

APP_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = APP_ROOT / "static"
DEFAULT_RESULTS_ROOT = APP_ROOT / "results"
MAX_REQUEST_BYTES = 40 * 1024 * 1024


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def safe_name(value: str, fallback: str = "unnamed") -> str:
    value = value.strip()
    value = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", value)
    value = re.sub(r"\s+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-.")
    return value[:100] or fallback


def endpoint_url(base_url: str) -> str:
    base_url = base_url.strip().rstrip("/")
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Base URL 必须是有效的 http(s) 地址")
    if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("除本机 mock 外，模型 API 必须使用 HTTPS")
    if base_url.endswith("/chat/completions"):
        return base_url
    return f"{base_url}/chat/completions"


def image_summary(data_url: str | None) -> dict[str, Any] | None:
    if not data_url:
        return None
    match = re.match(r"^data:([^;,]+);base64,(.+)$", data_url, flags=re.DOTALL)
    if not match:
        return {"kind": "external_or_invalid_data_url", "length": len(data_url)}
    mime = match.group(1)
    encoded = match.group(2)
    try:
        byte_size = len(base64.b64decode(encoded, validate=True))
    except Exception:
        byte_size = None
    return {"kind": "base64_data_url", "mime_type": mime, "byte_size": byte_size}


def build_messages(prompt: str, image_data_url: str | None) -> list[dict[str, Any]]:
    if image_data_url:
        return [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": image_data_url}},
                {"type": "text", "text": prompt},
            ],
        }]
    return [{"role": "user", "content": prompt}]


def sanitized_request_body(body: dict[str, Any], image_meta: dict[str, Any] | None) -> dict[str, Any]:
    clean = json.loads(json.dumps(body, ensure_ascii=False))
    for message in clean.get("messages", []):
        content = message.get("content")
        if isinstance(content, list):
            for part in content:
                if part.get("type") == "image_url" and isinstance(part.get("image_url"), dict):
                    part["image_url"]["url"] = f"<image omitted: {json.dumps(image_meta, ensure_ascii=False)}>"
    return clean


def normalize_usage(usage: Any) -> dict[str, Any]:
    if not isinstance(usage, dict):
        return {
            "input_tokens": None,
            "output_tokens": None,
            "total_tokens": None,
            "cached_input_tokens": None,
            "reasoning_tokens": None,
        }

    input_tokens = usage.get("prompt_tokens", usage.get("input_tokens"))
    output_tokens = usage.get("completion_tokens", usage.get("output_tokens"))
    total_tokens = usage.get("total_tokens")

    prompt_details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}
    completion_details = usage.get("completion_tokens_details") or usage.get("output_tokens_details") or {}
    cached = prompt_details.get("cached_tokens") if isinstance(prompt_details, dict) else None
    reasoning = completion_details.get("reasoning_tokens") if isinstance(completion_details, dict) else None

    if total_tokens is None and isinstance(input_tokens, int) and isinstance(output_tokens, int):
        total_tokens = input_tokens + output_tokens

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "cached_input_tokens": cached,
        "reasoning_tokens": reasoning,
    }


def extract_content(response_json: Any) -> str:
    if not isinstance(response_json, dict):
        return ""
    choices = response_json.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        return ""
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            value = part.get("text") or part.get("content")
            if isinstance(value, str):
                texts.append(value)
        return "\n".join(texts)
    return str(content) if content is not None else ""


def extract_json_object(text: str) -> Any:
    stripped = text.strip()
    stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.IGNORECASE)
    stripped = re.sub(r"\s*```$", "", stripped)
    decoder = json.JSONDecoder()
    for index, char in enumerate(stripped):
        if char not in "[{":
            continue
        try:
            value, _ = decoder.raw_decode(stripped[index:])
            return value
        except json.JSONDecodeError:
            continue
    raise ValueError("模型正文中未找到可解析的 JSON 对象")


def validate_model_json(value: Any, phase: str) -> list[str]:
    errors: list[str] = []
    if not isinstance(value, dict):
        return ["顶层必须是 JSON 对象"]
    if phase == "overall":
        scene = value.get("scene")
        items = value.get("items")
        if not isinstance(scene, dict):
            errors.append("scene 必须是对象")
        else:
            for field in ("context_zh", "caption_en", "caption_zh"):
                if not isinstance(scene.get(field), str) or not scene.get(field, "").strip():
                    errors.append(f"scene.{field} 缺失或不是非空字符串")
        if not isinstance(items, list):
            errors.append("items 必须是数组")
        else:
            ids: set[str] = set()
            if len(items) > 6:
                errors.append(f"items 数量为 {len(items)}，超过约定的 6 项")
            for index, item in enumerate(items, start=1):
                prefix = f"items[{index - 1}]"
                if not isinstance(item, dict):
                    errors.append(f"{prefix} 必须是对象")
                    continue
                for field in ("id", "name_en", "name_zh", "label_en", "label_zh"):
                    if not isinstance(item.get(field), str) or not item.get(field, "").strip():
                        errors.append(f"{prefix}.{field} 缺失或不是非空字符串")
                item_id = item.get("id")
                if isinstance(item_id, str):
                    if item_id in ids:
                        errors.append(f"{prefix}.id 重复：{item_id}")
                    ids.add(item_id)
                point = item.get("point")
                if not (isinstance(point, list) and len(point) == 2 and all(isinstance(v, int) for v in point)):
                    errors.append(f"{prefix}.point 必须是两个整数")
                elif not all(0 <= v <= 1000 for v in point):
                    errors.append(f"{prefix}.point 超出 0～1000 范围")
    elif phase == "item":
        for field in ("id", "meaning_zh", "usage_note_zh"):
            if not isinstance(value.get(field), str):
                errors.append(f"{field} 缺失或不是字符串")
        examples = value.get("examples")
        if not isinstance(examples, list) or len(examples) != 2:
            errors.append("examples 必须恰好包含 2 项")
        else:
            for index, example in enumerate(examples):
                if not isinstance(example, dict):
                    errors.append(f"examples[{index}] 必须是对象")
                    continue
                for field in ("en", "zh"):
                    if not isinstance(example.get(field), str) or not example.get(field, "").strip():
                        errors.append(f"examples[{index}].{field} 缺失或不是非空字符串")
    else:
        errors.append(f"未知 phase：{phase}")
    return errors


def request_headers_for_audit(headers: Any) -> dict[str, str]:
    result: dict[str, str] = {}
    for key in ("x-request-id", "x-tt-logid", "request-id", "x-log-id", "trace-id"):
        value = headers.get(key) if headers else None
        if value:
            result[key] = value
    return result


def call_model(config: dict[str, Any]) -> dict[str, Any]:
    prompt = str(config.get("prompt", "")).strip()
    api_key = str(config.get("api_key", "")).strip()
    model = str(config.get("model", "")).strip()
    base_url = str(config.get("base_url", "")).strip()
    phase = str(config.get("phase", "overall"))
    image_data_url = config.get("image_data_url") or None
    timeout_seconds = float(config.get("timeout_seconds", 180))
    extra_body = config.get("extra_body") or {}

    if not prompt:
        raise ValueError("提示词不能为空")
    if not api_key:
        raise ValueError("API Key 不能为空")
    if not model:
        raise ValueError("模型 ID 不能为空")
    if not isinstance(extra_body, dict):
        raise ValueError("额外请求参数必须是 JSON 对象")

    url = endpoint_url(base_url)
    image_meta = image_summary(image_data_url)
    body: dict[str, Any] = {
        "model": model,
        "messages": build_messages(prompt, image_data_url),
        "stream": False,
    }
    for key, value in extra_body.items():
        if key not in {"model", "messages", "stream"}:
            body[key] = value

    audit_body = sanitized_request_body(body, image_meta)
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "photo-english-model-tester/1.0",
        },
        method="POST",
    )

    started_at = utc_now_iso()
    started_ns = time.perf_counter_ns()
    response_status: int | None = None
    response_headers: dict[str, str] = {}
    raw_text = ""
    error_message: str | None = None

    print("\n" + "=" * 88, flush=True)
    print(f"[{started_at}] START phase={phase} model={model} endpoint={url}", flush=True)
    print("PROMPT BEGIN", flush=True)
    print(prompt, flush=True)
    print("PROMPT END", flush=True)
    print(f"IMAGE {json.dumps(image_meta, ensure_ascii=False) if image_meta else 'not attached'}", flush=True)

    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as response:
            response_status = response.status
            response_headers = request_headers_for_audit(response.headers)
            raw_text = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        response_status = exc.code
        response_headers = request_headers_for_audit(exc.headers)
        raw_text = exc.read().decode("utf-8", errors="replace")
        error_message = f"HTTP {exc.code}: {exc.reason}"
    except Exception as exc:
        error_message = f"{type(exc).__name__}: {exc}"

    elapsed_ms = round((time.perf_counter_ns() - started_ns) / 1_000_000, 3)
    finished_at = utc_now_iso()

    response_json: Any = None
    try:
        response_json = json.loads(raw_text) if raw_text else None
    except json.JSONDecodeError:
        if not error_message:
            error_message = "上游响应不是合法 JSON"

    content = extract_content(response_json)
    usage_raw = response_json.get("usage") if isinstance(response_json, dict) else None
    usage_normalized = normalize_usage(usage_raw)
    parsed_output: Any = None
    validation_errors: list[str] = []
    parse_error: str | None = None

    if content:
        try:
            parsed_output = extract_json_object(content)
            validation_errors = validate_model_json(parsed_output, phase)
        except Exception as exc:
            parse_error = str(exc)
    elif not error_message:
        parse_error = "响应中未找到 choices[0].message.content"

    success = bool(
        response_status is not None
        and 200 <= response_status < 300
        and not error_message
        and parsed_output is not None
        and not validation_errors
    )

    print(
        "RESULT "
        + json.dumps(
            {
                "success": success,
                "http_status": response_status,
                "elapsed_ms": elapsed_ms,
                "usage": usage_normalized,
                "request_ids": response_headers,
                "parse_error": parse_error,
                "validation_errors": validation_errors,
                "error": error_message,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    print("=" * 88, flush=True)

    return {
        "schema_version": "1.0",
        "success": success,
        "phase": phase,
        "started_at_utc": started_at,
        "finished_at_utc": finished_at,
        "request": {
            "provider": config.get("provider"),
            "model": model,
            "model_label": config.get("model_label"),
            "endpoint": url,
            "prompt": prompt,
            "image": image_meta,
            "body_without_image_or_secret": audit_body,
            "timeout_seconds": timeout_seconds,
        },
        "response": {
            "http_status": response_status,
            "request_ids": response_headers,
            "raw_json": response_json,
            "raw_text_if_non_json": None if response_json is not None else raw_text,
            "content": content,
            "parsed_json": parsed_output,
            "parse_error": parse_error,
            "validation_errors": validation_errors,
            "error": error_message,
        },
        "metrics": {
            "wall_clock_ms": elapsed_ms,
            "wall_clock_seconds": round(elapsed_ms / 1000, 3),
            "usage_raw": usage_raw,
            "usage_normalized": usage_normalized,
        },
        "test_context": {
            "test_run_id": config.get("test_run_id"),
            "item_index": config.get("item_index"),
            "item_id": config.get("item_id"),
            "detail_includes_image": bool(image_data_url) if phase == "item" else None,
        },
    }


def local_timestamp_from_utc(iso_value: str) -> str:
    try:
        parsed = datetime.fromisoformat(iso_value)
        return parsed.astimezone().strftime("%Y%m%d-%H%M%S")
    except (TypeError, ValueError):
        return datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")


def persist_result(
    result: dict[str, Any], config: dict[str, Any], results_root: Path
) -> tuple[Path, str]:
    model_label = safe_name(str(config.get("model_label") or config.get("model") or "model"), "model")
    phase = str(config.get("phase", "overall"))

    if phase == "overall":
        requested_run_id = str(config.get("test_run_id") or "").strip()
        if requested_run_id:
            raise ValueError("首轮调用不得复用已有测试批次")
        stamp = local_timestamp_from_utc(str(result.get("started_at_utc", "")))
        base_run_id = safe_name(f"{model_label}-{stamp}", f"{model_label}-run")
        test_run_id = base_run_id
        suffix = 2
        while (results_root / test_run_id).exists():
            test_run_id = f"{base_run_id}-{suffix}"
            suffix += 1
        filename = f"{model_label}-总体结果.json"
    else:
        test_run_id = safe_name(str(config.get("test_run_id") or ""), "")
        if not test_run_id:
            raise ValueError("详情调用缺少测试批次，请先完成一次首轮测试")
        run_dir = results_root / test_run_id
        if not run_dir.is_dir():
            raise ValueError(f"测试批次不存在：{test_run_id}")
        overall_files = sorted(run_dir.glob("*-总体结果.json"))
        if len(overall_files) != 1:
            raise ValueError(f"测试批次缺少唯一的总体结果：{test_run_id}")
        try:
            overall_data = json.loads(overall_files[0].read_text(encoding="utf-8"))
            overall_request = overall_data.get("request", {})
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"无法读取测试批次总体结果：{exc}") from exc
        if overall_request.get("model") != config.get("model") or overall_request.get("model_label") != config.get("model_label"):
            raise ValueError("当前模型配置与该测试批次首轮模型不同，请重新执行首轮测试创建新目录")
        item_index = int(config.get("item_index") or 1)
        filename = f"{model_label}-item{item_index}.json"

    result.setdefault("test_context", {})["test_run_id"] = test_run_id
    target_dir = results_root / test_run_id
    archive_dir = target_dir / "archive"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / filename

    if target.exists():
        archive_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        shutil.copy2(target, archive_dir / f"{target.stem}__{stamp}{target.suffix}")

    temporary = target.with_suffix(target.suffix + f".{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, target)
    return target, test_run_id


class AppHandler(SimpleHTTPRequestHandler):
    server_version = "PhotoEnglishTester/1.0"

    def __init__(self, *args: Any, directory: str | None = None, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_ROOT), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write("[http] " + (fmt % args) + "\n")
        sys.stdout.flush()

    @property
    def results_root(self) -> Path:
        return Path(getattr(self.server, "results_root", DEFAULT_RESULTS_ROOT))

    def send_json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json(200, {"ok": True, "time": utc_now_iso()})
            return
        if parsed.path == "/api/results":
            files: list[dict[str, Any]] = []
            if self.results_root.exists():
                for path in sorted(self.results_root.rglob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
                    if "archive" in path.parts:
                        continue
                    files.append({
                        "path": str(path.relative_to(self.results_root)),
                        "size": path.stat().st_size,
                        "modified_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
                    })
            self.send_json(200, {"files": files})
            return
        if parsed.path in {"", "/"}:
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/run":
            self.send_json(404, {"error": "Not found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "无效的 Content-Length"})
            return
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": f"请求体必须在 1～{MAX_REQUEST_BYTES} 字节之间"})
            return

        try:
            raw = self.rfile.read(content_length)
            config = json.loads(raw.decode("utf-8"))
            if not isinstance(config, dict):
                raise ValueError("请求体必须是 JSON 对象")
            result = call_model(config)
            saved_path, test_run_id = persist_result(result, config, self.results_root)
            response_payload = {
                "result": result,
                "test_run_id": test_run_id,
                "saved_path": str(saved_path),
                "saved_relative_path": str(saved_path.relative_to(self.results_root)),
            }
            self.send_json(200, response_payload)
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            traceback.print_exc()
            self.send_json(500, {"error": f"服务器错误：{type(exc).__name__}: {exc}"})


def build_server(host: str, port: int, results_root: Path) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), AppHandler)
    server.results_root = str(results_root)  # type: ignore[attr-defined]
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="有道拍照学英语模型测试工具")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--results-dir", type=Path, default=DEFAULT_RESULTS_ROOT)
    args = parser.parse_args()

    args.results_dir.mkdir(parents=True, exist_ok=True)
    server = build_server(args.host, args.port, args.results_dir.resolve())
    print(f"Model tester running at http://{args.host}:{server.server_port}", flush=True)
    print(f"Results directory: {args.results_dir.resolve()}", flush=True)
    print("API keys are kept in memory only and are never written to disk.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
