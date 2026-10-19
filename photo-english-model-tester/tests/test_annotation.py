#!/usr/bin/env python3
"""Integration test for coordinate annotation generation."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def make_record() -> dict:
    return {
        "success": True,
        "response": {
            "parsed_json": {
                "scene": {"context_zh": "测试场景", "caption_en": "Scene", "caption_zh": "场景"},
                "items": [
                    {
                        "id": "i1",
                        "name_en": "pumpkin",
                        "name_zh": "南瓜",
                        "label_en": "orange pumpkin",
                        "label_zh": "橙色南瓜",
                        "point": [500, 500],
                    }
                ],
            }
        },
    }


def main() -> None:
    import sys
    sys.path.insert(0, str(ROOT))
    from PIL import Image
    from server import generate_annotations

    with tempfile.TemporaryDirectory() as tmp:
        results = Path(tmp)
        batch = results / "批量测试-20261019-120000"
        run1 = batch / "seed-2.1-lite-20261019-120001"
        run2 = batch / "seed-2.1-lite-20261019-120002"
        run1.mkdir(parents=True)
        run2.mkdir(parents=True)
        for run, image_name in ((run1, "原图-a.png"), (run2, "custom-image.png")):
            Image.new("RGB", (320, 240), (235, 240, 245)).save(run / image_name, format="PNG")
            (run / "seed-2.1-lite-总体结果.json").write_text(json.dumps(make_record(), ensure_ascii=False), encoding="utf-8")

        first = generate_annotations(results, batch.name)
        assert first["run_directory_count"] == 2
        assert len(first["generated"]) == 2
        assert not first["failed"]
        for run in (run1, run2):
            output = run / "坐标标注图.png"
            assert output.is_file()
            with Image.open(output) as image:
                assert image.format == "PNG"
                assert image.size == (320, 240)

        second = generate_annotations(results, batch.name)
        assert len(second["generated"]) == 2
        for run in (run1, run2):
            archived = list((run / "archive").glob("坐标标注图__*.png"))
            assert len(archived) == 1
        print("PASS: audit JSON annotation, generic image fallback, recursive batch, repeat archive")


if __name__ == "__main__":
    main()
