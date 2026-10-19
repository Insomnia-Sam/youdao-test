#!/usr/bin/env python3
"""在图片上标注归一化坐标点（0~1000）及中文标签。

用法：
    python3 annotate_image.py source_image.png annotations.json annotated_image.png

依赖：Pillow（PIL）。
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFont


@dataclass(frozen=True)
class LabelPlacement:
    rect: tuple[int, int, int, int]
    text_pos: tuple[int, int]
    anchor: tuple[int, int]


def normalized_to_pixel(point: Iterable[float], width: int, height: int) -> tuple[int, int]:
    """把 [0,1000] 归一化坐标换算成图像像素坐标。"""
    x_norm, y_norm = point
    if not (0 <= x_norm <= 1000 and 0 <= y_norm <= 1000):
        raise ValueError(f"归一化坐标超出 0~1000：{point}")
    x = round(x_norm / 1000 * (width - 1))
    y = round(y_norm / 1000 * (height - 1))
    return x, y


def intersects(a: tuple[int, int, int, int], b: tuple[int, int, int, int], margin: int = 6) -> bool:
    return not (
        a[2] + margin <= b[0]
        or b[2] + margin <= a[0]
        or a[3] + margin <= b[1]
        or b[3] + margin <= a[1]
    )


def clamp(value: int, low: int, high: int) -> int:
    return max(low, min(value, high))


def choose_label_placement(
    point: tuple[int, int],
    text_size: tuple[int, int],
    canvas_size: tuple[int, int],
    occupied: list[tuple[int, int, int, int]],
    padding: int,
    gap: int,
) -> LabelPlacement:
    """优先在点的四周摆放标签，并尽量避免越界和标签重叠。"""
    px, py = point
    text_w, text_h = text_size
    box_w, box_h = text_w + padding * 2, text_h + padding * 2
    width, height = canvas_size

    candidates = [
        (px + gap, py - box_h - gap),       # 右上
        (px + gap, py + gap),               # 右下
        (px - box_w - gap, py - box_h - gap),  # 左上
        (px - box_w - gap, py + gap),       # 左下
        (px - box_w // 2, py - box_h - gap),   # 正上
        (px - box_w // 2, py + gap),           # 正下
    ]

    best_rect = None
    best_score = None
    for raw_x, raw_y in candidates:
        x1 = clamp(raw_x, 4, max(4, width - box_w - 4))
        y1 = clamp(raw_y, 4, max(4, height - box_h - 4))
        rect = (x1, y1, x1 + box_w, y1 + box_h)
        collision_count = sum(intersects(rect, old) for old in occupied)
        displacement = abs(x1 - raw_x) + abs(y1 - raw_y)
        score = collision_count * 100000 + displacement
        if best_score is None or score < best_score:
            best_score, best_rect = score, rect

    assert best_rect is not None
    x1, y1, x2, y2 = best_rect
    anchor = (clamp(px, x1, x2), clamp(py, y1, y2))
    return LabelPlacement(best_rect, (x1 + padding, y1 + padding), anchor)


def load_font(font_path: str | None, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        font_path,
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size, index=0)
    return ImageFont.load_default()


def annotate(
    input_path: Path,
    metadata_path: Path,
    output_path: Path,
    font_path: str | None = None,
) -> None:
    image = Image.open(input_path).convert("RGBA")
    width, height = image.size
    with metadata_path.open("r", encoding="utf-8") as fp:
        data = json.load(fp)

    items = data.get("items")
    if not isinstance(items, list):
        raise ValueError("JSON 中缺少 items 数组")

    scale = max(1.0, min(width, height) / 900)
    font_size = max(22, round(25 * scale))
    padding = max(8, round(9 * scale))
    gap = max(24, round(30 * scale))
    dot_outer = max(8, round(9 * scale))
    dot_inner = max(4, round(4 * scale))
    line_width = max(2, round(2 * scale))
    radius = max(8, round(10 * scale))
    font = load_font(font_path, font_size)

    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    occupied: list[tuple[int, int, int, int]] = []

    for item in items:
        point = normalized_to_pixel(item["point"], width, height)
        label = item.get("label_zh") or item.get("name_zh") or item.get("name_en") or item.get("id", "物品")

        text_bbox = draw.textbbox((0, 0), label, font=font, stroke_width=0)
        text_size = (text_bbox[2] - text_bbox[0], text_bbox[3] - text_bbox[1])
        placement = choose_label_placement(
            point, text_size, image.size, occupied, padding=padding, gap=gap
        )
        occupied.append(placement.rect)

        # 先画带阴影的引导线，再画标签框，保证标签清楚可读。
        draw.line([point, placement.anchor], fill=(0, 0, 0, 170), width=line_width + 2)
        draw.line([point, placement.anchor], fill=(255, 255, 255, 235), width=line_width)

        shadow = (
            placement.rect[0] + 3,
            placement.rect[1] + 3,
            placement.rect[2] + 3,
            placement.rect[3] + 3,
        )
        draw.rounded_rectangle(shadow, radius=radius, fill=(0, 0, 0, 90))
        draw.rounded_rectangle(
            placement.rect,
            radius=radius,
            fill=(12, 12, 12, 220),
            outline=(255, 255, 255, 210),
            width=max(1, line_width),
        )
        draw.text(placement.text_pos, label, font=font, fill=(255, 255, 255, 255))

        px, py = point
        draw.ellipse(
            [px - dot_outer, py - dot_outer, px + dot_outer, py + dot_outer],
            fill=(0, 0, 0, 230),
            outline=(255, 255, 255, 255),
            width=max(2, line_width),
        )
        draw.ellipse(
            [px - dot_inner, py - dot_inner, px + dot_inner, py + dot_inner],
            fill=(255, 153, 0, 255),
        )

        print(f"{item.get('id', '-')}: {item['point']} -> pixel {point} | {label}")

    result = Image.alpha_composite(image, overlay).convert("RGB")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    result.save(output_path, quality=95)
    print(f"saved: {output_path} ({width}x{height})")


def main() -> None:
    parser = argparse.ArgumentParser(description="用 0~1000 归一化坐标给图片添加物品标签")
    parser.add_argument("image", type=Path, help="输入图片")
    parser.add_argument("json", type=Path, help="包含 items 的 JSON 文件")
    parser.add_argument("output", type=Path, help="输出图片（推荐 PNG 或 JPG）")
    parser.add_argument("--font", help="可选：支持中文的字体文件路径")
    args = parser.parse_args()
    annotate(args.image, args.json, args.output, args.font)


if __name__ == "__main__":
    main()
