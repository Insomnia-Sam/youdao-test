#!/usr/bin/env python3
"""Tiny local OpenAI-compatible upstream used by automated tests."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OVERALL = {
    "scene": {
        "context_zh": "女孩在迪士尼乐园的万圣节主题巨型南瓜装置前拍照留念。",
        "caption_en": "Posing in front of a giant Mickey pumpkin at Disney's Halloween Time.",
        "caption_zh": "在迪士尼万圣节活动的巨型米奇南瓜前摆拍。",
    },
    "items": [
        {
            "id": "i1",
            "name_en": "Mickey pumpkin",
            "name_zh": "米奇南瓜",
            "label_en": "Mickey-shaped pumpkin",
            "label_zh": "米奇造型南瓜",
            "point": [500, 380],
        }
    ],
}

ITEM = {
    "id": "i1",
    "meaning_zh": "指迪士尼乐园万圣节期间以米奇头像为造型的巨型南瓜装饰。",
    "examples": [
        {"en": "We took a photo with the Mickey pumpkin.", "zh": "我们和米奇南瓜合了影。"},
        {"en": "She carved a pumpkin for Halloween.", "zh": "她为万圣节雕了一个南瓜。"},
    ],
    "usage_note_zh": "口语里可直接说 Mickey pumpkin。",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        messages = payload.get("messages", [])
        content = messages[0].get("content", "") if messages else ""
        if isinstance(content, list):
            text = "\n".join(part.get("text", "") for part in content if part.get("type") == "text")
        else:
            text = str(content)
        result = ITEM if "指定条目" in text else OVERALL
        response = {
            "id": "mock-response",
            "model": payload.get("model", "mock-model"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": json.dumps(result, ensure_ascii=False)}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": 321,
                "completion_tokens": 123,
                "total_tokens": 444,
                "prompt_tokens_details": {"cached_tokens": 20},
                "completion_tokens_details": {"reasoning_tokens": 0},
            },
        }
        raw = json.dumps(response, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("x-request-id", "mock-request-001")
        self.end_headers()
        self.wfile.write(raw)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(server.server_port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
