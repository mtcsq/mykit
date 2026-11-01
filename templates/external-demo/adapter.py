#!/usr/bin/env python3
"""external/adapter 协议的参考实现（只用标准库）。

约定：收到帧区间 [start, end)，把 fNNNNN.png 写进 --out 目录，退出码 0 表示成功。
这里故意不用任何第三方库（没有 Pillow / numpy），证明"接别人的工具链"不等于"装一堆依赖"。
"""
import argparse
import json
import struct
import zlib
from pathlib import Path

W, H, FPS = 640, 360, 24


def write_png(path, width, height, rgb):
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        start = y * width * 3
        raw += rgb[start:start + width * 3]

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    blob = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b"")
    with open(path, "wb") as handle:
        handle.write(blob)


def hex_rgb(text, fallback):
    text = (text or "").lstrip("#")
    if len(text) != 6:
        return fallback
    return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))


def render(frame, total, accent):
    t = frame / max(1, total - 1)
    buf = bytearray(W * H * 3)
    # 背景：从深到浅的竖向渐变（纯函数，不用随机数）
    for y in range(H):
        k = y / H
        r = int(12 + 30 * k)
        g = int(14 + 26 * k)
        b = int(18 + 34 * k)
        row = bytes((r, g, b)) * W
        buf[y * W * 3:(y + 1) * W * 3] = row
    # 移动方块
    size = 90
    cx = int((W - size) * t)
    cy = int((H - size) * (0.5 + 0.35 * (1 if int(t * 2) % 2 == 0 else -1) * t))
    for y in range(max(0, cy), min(H, cy + size)):
        for x in range(max(0, cx), min(W, cx + size)):
            i = (y * W + x) * 3
            buf[i], buf[i + 1], buf[i + 2] = accent
    # 进度条
    bar = int(W * t)
    for y in range(H - 18, H - 6):
        for x in range(0, bar):
            i = (y * W + x) * 3
            buf[i], buf[i + 1], buf[i + 2] = accent
    return bytes(buf)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--inputs", default="")
    args = ap.parse_args()

    start, end = (int(x) for x in args.frames.split("-"))
    params = {}
    if args.inputs:
        with open(args.inputs, "r", encoding="utf-8") as handle:
            params = json.load(handle)
    accent = hex_rgb(params.get("accent"), (255, 74, 28))
    total = round(2 * FPS)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for frame in range(start, end):
        write_png(out / ("f%05d.png" % frame), W, H, render(frame, total, accent))
    print("adapter: %d-%d done" % (start, end))


if __name__ == "__main__":
    main()
