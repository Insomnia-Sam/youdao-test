#!/usr/bin/env python3
"""End-to-end smoke test using a local mock upstream."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZmxsAAAAASUVORK5CYII="


def wait_line(proc: subprocess.Popen[str], timeout: float = 5.0) -> str:
    started = time.time()
    while time.time() - started < timeout:
        line = proc.stdout.readline().strip()  # type: ignore[union-attr]
        if line:
            return line
    raise TimeoutError("process did not print startup line")


def post(url: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def stop_process(proc: subprocess.Popen[str] | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=3)


def main() -> None:
    upstream = subprocess.Popen(
        [sys.executable, str(ROOT / "tests" / "mock_upstream.py")],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    app = None
    try:
        upstream_port = int(wait_line(upstream))
        with tempfile.TemporaryDirectory() as tmp:
            app = subprocess.Popen(
                [
                    sys.executable,
                    str(ROOT / "server.py"),
                    "--port", "0",
                    "--results-dir", tmp,
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
            startup = wait_line(app)
            app_port = int(startup.rsplit(":", 1)[1])
            base_payload = {
                "provider": "mock",
                "base_url": f"http://127.0.0.1:{upstream_port}/v1",
                "model": "mock-model",
                "model_label": "seed-2.1-lite",
                "api_key": "super-secret-test-key",
                "timeout_seconds": 10,
                "extra_body": {"response_format": {"type": "json_object"}},
            }
            overall = post(f"http://127.0.0.1:{app_port}/api/run", {
                **base_payload,
                "phase": "overall",
                "prompt": "你是英语学习内容编辑。",
                "image_data_url": PIXEL,
            })
            assert overall["result"]["success"] is True
            assert overall["result"]["metrics"]["usage_normalized"] == {
                "input_tokens": 321,
                "output_tokens": 123,
                "total_tokens": 444,
                "cached_input_tokens": 20,
                "reasoning_tokens": 0,
            }
            assert "super-secret-test-key" not in json.dumps(overall, ensure_ascii=False)
            assert PIXEL not in json.dumps(overall, ensure_ascii=False)
            assert overall["result"]["response"]["request_ids"]["x-request-id"] == "mock-request-001"
            assert overall["test_run_id"].startswith("seed-2.1-lite-")
            assert Path(overall["saved_path"]).parent.name == overall["test_run_id"]
            assert Path(overall["saved_path"]).name == "seed-2.1-lite-总体结果.json"

            item = post(f"http://127.0.0.1:{app_port}/api/run", {
                **base_payload,
                "phase": "item",
                "test_run_id": overall["test_run_id"],
                "item_index": 1,
                "item_id": "i1",
                "prompt": "你是英语学习内容编辑，为指定条目生成简短详情。",
                "image_data_url": None,
            })
            assert item["result"]["success"] is True
            assert item["result"]["test_context"]["detail_includes_image"] is False
            assert item["test_run_id"] == overall["test_run_id"]
            assert Path(item["saved_path"]).parent == Path(overall["saved_path"]).parent
            assert Path(item["saved_path"]).name == "seed-2.1-lite-item1.json"

            second_overall = post(f"http://127.0.0.1:{app_port}/api/run", {
                **base_payload,
                "phase": "overall",
                "prompt": "第二轮首轮测试。",
                "image_data_url": PIXEL,
            })
            assert second_overall["test_run_id"] != overall["test_run_id"]
            assert Path(second_overall["saved_path"]).parent != Path(overall["saved_path"]).parent

            saved_overall = json.loads(Path(overall["saved_path"]).read_text(encoding="utf-8"))
            serialized = json.dumps(saved_overall, ensure_ascii=False)
            assert "super-secret-test-key" not in serialized
            assert PIXEL not in serialized
            assert saved_overall["request"]["image"]["byte_size"] is not None
            print("PASS: overall + item calls, metrics, filenames, audit redaction")
    finally:
        stop_process(app)
        stop_process(upstream)


if __name__ == "__main__":
    main()
