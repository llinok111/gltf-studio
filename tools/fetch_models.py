#!/usr/bin/env python
"""
tools/fetch_models.py — 断点续传 + 完整性校验的样例模型下载器

背景：本机到 raw.githubusercontent.com 的连接会被中途掐断，
curl 单次下载经常只拿到 20%~60% 就返回，而 GLB 的 JSON 头里写了总长度，
所以可以据此判断"还差多少"，用 Range 请求一段段补齐。

用法：
    python tools/fetch_models.py            # 下载全部
    python tools/fetch_models.py ToyCar     # 只下一个
"""
import json
import os
import struct
import sys
import time
import urllib.request

BASE = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "models")

MODELS = {
    "AntiqueCamera": "AntiqueCamera/glTF-Binary/AntiqueCamera.glb",
    "ToyCar": "ToyCar/glTF-Binary/ToyCar.glb",
}

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def declared_size(path):
    """读 GLB 头里的 total length 字段"""
    try:
        with open(path, "rb") as f:
            head = f.read(12)
        if len(head) < 12 or head[:4] != b"glTF":
            return None
        return struct.unpack("<I", head[8:12])[0]
    except OSError:
        return None


def fetch(name, rel, max_attempts=60):
    os.makedirs(OUT, exist_ok=True)
    dst = os.path.join(OUT, name + ".glb")
    url = f"{BASE}/{rel}"

    for attempt in range(1, max_attempts + 1):
        cur = os.path.getsize(dst) if os.path.exists(dst) else 0
        total = declared_size(dst) if cur >= 12 else None

        if total and cur >= total:
            print(f"[{name}] OK  {cur:,} / {total:,} bytes")
            return True

        headers = dict(UA)
        if cur:
            headers["Range"] = f"bytes={cur}-"
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                mode = "ab" if cur and r.status == 206 else "wb"
                if mode == "wb":
                    cur = 0
                chunk = r.read(1 << 16)
                with open(dst, mode) as f:
                    while chunk:
                        f.write(chunk)
                        chunk = r.read(1 << 16)
        except Exception as e:  # 网络中断是常态，继续下一轮续传
            print(f"[{name}] attempt {attempt}: {type(e).__name__}, size={os.path.getsize(dst) if os.path.exists(dst) else 0:,}")
            time.sleep(0.4)
            continue

        total = declared_size(dst)
        got = os.path.getsize(dst)
        print(f"[{name}] attempt {attempt}: {got:,} / {total:,}")
        if total and got >= total:
            print(f"[{name}] DONE {got:,} bytes")
            return True

    print(f"[{name}] FAILED after {max_attempts} attempts")
    return False


if __name__ == "__main__":
    targets = sys.argv[1:] or list(MODELS)
    ok = True
    for t in targets:
        if t not in MODELS:
            print("unknown model:", t)
            ok = False
            continue
        ok = fetch(t, MODELS[t]) and ok
    sys.exit(0 if ok else 1)
