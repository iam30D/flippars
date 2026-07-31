"""Generate raster exports from the code-native Flippars brand mark."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "apps" / "mobile" / "assets"

DARK = "#111A2F"
SPLASH = "#0B1020"
MUTED = "#90A0BD"
GREEN = "#54D6A0"
ORANGE = "#FFB86B"


def cubic(
    start: tuple[float, float],
    control_a: tuple[float, float],
    control_b: tuple[float, float],
    end: tuple[float, float],
    steps: int = 80,
) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for index in range(steps + 1):
        time = index / steps
        inverse = 1 - time
        points.append(
            (
                inverse**3 * start[0]
                + 3 * inverse**2 * time * control_a[0]
                + 3 * inverse * time**2 * control_b[0]
                + time**3 * end[0],
                inverse**3 * start[1]
                + 3 * inverse**2 * time * control_a[1]
                + 3 * inverse * time**2 * control_b[1]
                + time**3 * end[1],
            )
        )
    return points


def scaled(
    points: Iterable[tuple[float, float]], scale: float, offset: float
) -> list[tuple[float, float]]:
    return [(offset + x * scale, offset + y * scale) for x, y in points]


def rounded_path(
    draw: ImageDraw.ImageDraw,
    points: list[tuple[float, float]],
    *,
    fill: str,
    width: int,
) -> None:
    radius = width / 2
    for start, end in zip(points, points[1:]):
        draw.line((*start, *end), fill=fill, width=width)
    for x, y in points:
        draw.ellipse(
            (x - radius, y - radius, x + radius, y + radius),
            fill=fill,
        )


def draw_mark(
    image: Image.Image,
    *,
    offset: float,
    size: float,
    background: str | None,
    monochrome: bool = False,
) -> None:
    draw = ImageDraw.Draw(image)
    scale = size / 256
    if background is not None:
        draw.rounded_rectangle(
            (offset, offset, offset + size, offset + size),
            radius=58 * scale,
            fill=background,
        )

    neutral = "white" if monochrome else MUTED
    upward = "white" if monochrome else GREEN
    downward = "white" if monochrome else ORANGE
    line_width = max(1, round(12 * scale))
    path_width = max(1, round(18 * scale))
    draw.line(
        (
            offset + 40 * scale,
            offset + 128 * scale,
            offset + 216 * scale,
            offset + 128 * scale,
        ),
        fill=neutral,
        width=line_width,
    )
    green = [
        *cubic((48, 72), (100, 72), (150, 60), (150, 128)),
        *cubic((150, 128), (150, 184), (174, 184), (208, 184))[1:],
    ]
    orange = [
        *cubic((48, 184), (110, 184), (141, 190), (141, 128)),
        *cubic((141, 128), (141, 72), (174, 72), (208, 72))[1:],
    ]
    green_points = scaled(green, scale, offset)
    orange_points = scaled(orange, scale, offset)
    rounded_path(
        draw,
        green_points,
        fill=upward,
        width=path_width,
    )
    rounded_path(
        draw,
        orange_points,
        fill=downward,
        width=path_width,
    )


def export() -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)

    icon = Image.new("RGB", (1024, 1024), DARK)
    draw_mark(icon, offset=0, size=1024, background=DARK)
    icon.save(ASSET_DIR / "icon.png", optimize=True)

    splash = Image.new("RGB", (1024, 1024), SPLASH)
    draw_mark(splash, offset=256, size=512, background=DARK)
    splash.save(ASSET_DIR / "splash-icon.png", optimize=True)

    notification = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
    draw_mark(
        notification,
        offset=54,
        size=324,
        background=None,
        monochrome=True,
    )
    notification.save(ASSET_DIR / "notification-icon.png", optimize=True)


if __name__ == "__main__":
    export()
