from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from PIL import Image, ImageDraw, ImageFont


@dataclass(frozen=True)
class LabelPlacement:
    rect: tuple[int, int, int, int]
    text_pos: tuple[int, int]
    anchor: tuple[int, int]


def normalized_to_pixel(point: Iterable[float], width: int, height: int) -> tuple[int, int]:
    values = list(point)
    if len(values) != 2:
        raise ValueError(f"坐标必须包含两个值：{values}")
    x_norm, y_norm = values
    if not (isinstance(x_norm, (int, float)) and isinstance(y_norm, (int, float))):
        raise ValueError(f"坐标必须为数字：{values}")
    if not (0 <= x_norm <= 1000 and 0 <= y_norm <= 1000):
        raise ValueError(f"归一化坐标超出 0~1000：{values}")
    return round(x_norm / 1000 * (width - 1)), round(y_norm / 1000 * (height - 1))


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
    px, py = point
    text_w, text_h = text_size
    box_w, box_h = text_w + padding * 2, text_h + padding * 2
    width, height = canvas_size
    candidates = [
        (px + gap, py - box_h - gap),
        (px + gap, py + gap),
        (px - box_w - gap, py - box_h - gap),
        (px - box_w - gap, py + gap),
        (px - box_w // 2, py - box_h - gap),
        (px - box_w // 2, py + gap),
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
    if best_rect is None:
        raise ValueError("无法计算标签位置")
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


def extract_items(record: Any) -> list[dict[str, Any]]:
    if not isinstance(record, dict):
        raise ValueError("总体结果 JSON 顶层必须是对象")
    candidates = [
        record.get("items"),
        (record.get("response") or {}).get("parsed_json", {}).get("items")
        if isinstance(record.get("response"), dict) and isinstance((record.get("response") or {}).get("parsed_json"), dict)
        else None,
    ]
    for items in candidates:
        if isinstance(items, list):
            if not items:
                raise ValueError("总体结果 items 为空，无法生成坐标标注图")
            return items
    raise ValueError("总体结果中未找到 items 数组")


def annotate_items(
    input_path: Path,
    items: list[dict[str, Any]],
    output_path: Path,
    font_path: str | None = None,
) -> dict[str, Any]:
    with Image.open(input_path) as opened:
        image = opened.convert("RGBA")
    width, height = image.size
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
    placements = []

    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"items[{index - 1}] 必须是对象")
        if "point" not in item:
            raise ValueError(f"items[{index - 1}] 缺少 point")
        point = normalized_to_pixel(item["point"], width, height)
        label = str(item.get("label_zh") or item.get("name_zh") or item.get("name_en") or item.get("id") or f"物品{index}")
        text_bbox = draw.textbbox((0, 0), label, font=font, stroke_width=0)
        text_size = (text_bbox[2] - text_bbox[0], text_bbox[3] - text_bbox[1])
        placement = choose_label_placement(point, text_size, image.size, occupied, padding, gap)
        occupied.append(placement.rect)

        draw.line([point, placement.anchor], fill=(0, 0, 0, 170), width=line_width + 2)
        draw.line([point, placement.anchor], fill=(255, 255, 255, 235), width=line_width)
        shadow = tuple(value + 3 for value in placement.rect)
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
        placements.append({
            "id": item.get("id"),
            "normalized_point": list(item["point"]),
            "pixel_point": list(point),
            "label": label,
        })

    result = Image.alpha_composite(image, overlay).convert("RGB")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(f".{output_path.name}.tmp.png")
    result.save(temporary, format="PNG", optimize=True)
    temporary.replace(output_path)
    return {
        "output": str(output_path),
        "width": width,
        "height": height,
        "item_count": len(items),
        "placements": placements,
    }


def annotate_from_result(
    input_path: Path,
    result_json_path: Path,
    output_path: Path,
    font_path: str | None = None,
) -> dict[str, Any]:
    record = json.loads(result_json_path.read_text(encoding="utf-8"))
    items = extract_items(record)
    result = annotate_items(input_path, items, output_path, font_path)
    result["input"] = str(input_path)
    result["result_json"] = str(result_json_path)
    return result
