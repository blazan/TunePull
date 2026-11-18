#!/usr/bin/env python3
"""Generate the extension icons as PNGs using only the standard library.

Draws a red rounded tile with a white eighth-note glyph, rendered with 4x
supersampling for smooth edges. Re-run with:  python tools/make_icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"
SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor

RED_A = (255, 0, 51)
RED_B = (255, 77, 109)
WHITE = (255, 255, 255)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def mix(c1: tuple, c2: tuple, t: float) -> tuple:
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


def inside_rounded_rect(x: float, y: float, size: float, radius: float) -> bool:
    if x < 0 or y < 0 or x > size or y > size:
        return False
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= radius * radius


def inside_ellipse(x: float, y: float, cx: float, cy: float, rx: float, ry: float) -> bool:
    dx = (x - cx) / rx
    dy = (y - cy) / ry
    return dx * dx + dy * dy <= 1.0


def note_parts(size: float):
    """Geometry for an eighth note, in units of `size`."""
    head_cx = 0.40 * size
    head_cy = 0.70 * size
    head_rx = 0.155 * size
    head_ry = 0.125 * size

    stem_x = head_cx + head_rx - 0.045 * size
    stem_w = 0.058 * size
    stem_top = 0.24 * size
    stem_bottom = head_cy

    flag_x0 = stem_x + stem_w
    flag_top = 0.24 * size
    flag_h = 0.20 * size
    flag_w = 0.20 * size
    return head_cx, head_cy, head_rx, head_ry, stem_x, stem_w, stem_top, stem_bottom, flag_x0, flag_top, flag_h, flag_w


def inside_note(x: float, y: float, size: float) -> bool:
    (
        head_cx,
        head_cy,
        head_rx,
        head_ry,
        stem_x,
        stem_w,
        stem_top,
        stem_bottom,
        flag_x0,
        flag_top,
        flag_h,
        flag_w,
    ) = note_parts(size)

    if inside_ellipse(x, y, head_cx, head_cy, head_rx, head_ry):
        return True
    if stem_x <= x <= stem_x + stem_w and stem_top <= y <= stem_bottom:
        return True
    # Flag: a rounded wedge sweeping down-right from the top of the stem.
    fx = (x - flag_x0) / flag_w
    fy = (y - flag_top) / flag_h
    if 0.0 <= fx <= 1.0 and 0.0 <= fy <= 1.0 and fx + fy <= 1.15:
        return True
    return False


def sample(x: float, y: float, size: float, radius: float) -> tuple | None:
    if not inside_rounded_rect(x, y, size, radius):
        return None
    if inside_note(x, y, size):
        return WHITE
    return mix(RED_A, RED_B, y / size)


def render(size: int) -> bytes:
    radius = 0.24 * size
    hi = size * SS
    # Accumulate colour and coverage per output pixel.
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = 0.0
            hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    colour = sample(x, y, size, radius)
                    if colour:
                        r += colour[0]
                        g += colour[1]
                        b += colour[2]
                        hits += 1
            total = SS * SS
            if hits:
                # Premultiply against a transparent background.
                alpha = int(round(255 * hits / total))
                row += bytes(
                    (
                        int(round(r / hits)),
                        int(round(g / hits)),
                        int(round(b / hits)),
                        alpha,
                    )
                )
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    return encode_png(size, size, rows)


def encode_png(width: int, height: int, rows: list[bytes]) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    raw = b"".join(b"\x00" + row for row in rows)  # filter type 0 per scanline
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon{size}.png"
        path.write_bytes(render(size))
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
