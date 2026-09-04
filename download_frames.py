#!/usr/bin/env python3
"""Download generated frames for the pet project."""
import urllib.request
import sys
import os

BASE = r"F:\ss_yong\si\pet-si\assets"

FRAMES = {
    "blink": ["fn2sXQoEfM", "FXy15Nfwef", "ZTyshAvcTW", "hdUeaead6G", "s2E8uJaeKw"],
    "happy": ["LAEY7lhmgV", "5xDMAlzDCT", "wTWnouXMnH", "XUfOtGkwvO", "U2JcNfSIjG"],
    "charge": ["cXcruXx4Em", "UilMPWn0Q8", "eai3aVhAvU", "pRLnZREGUw", "Kyd0B13R4Q"],
    "music": ["8lYWr9NStk", "VOOxNS4Yot", "n8MKAhtjqW", "uBb8bpUbco", "55VL8VrKwc"],
    "pet": ["Ok2QX3SmAI", "iiZJomiS2f", "2svs5xG9u7", "btULWjgN4N", "GDlk59IoIL"],
    "badge": ["X4FUMUcbZl", "CdSPE1z9AM", "UiUQOZfyvB", "ZCtRuBHJ3c", "QI5Qqpmh4p"],
    "peek": ["0NJH49kbNN", "CKW0qyNDtQ", "GZCWDr9xa4", "4BplUa6Wjq", "fMQlXWPVMX"],
    "notify": ["VBOUh6qpSH", "ts8MxgY3rO", "TFHs2w4l2k", "SXADaHVZ1q", "lytIVvw0bp"],
}

failures = []
for state, keys in FRAMES.items():
    d = os.path.join(BASE, state)
    os.makedirs(d, exist_ok=True)
    for i, key in enumerate(keys, start=1):
        url = f"https://aka.doubaocdn.com/s/{key}"
        dest = os.path.join(d, f"{state}-{i:02d}.png")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as f:
                f.write(resp.read())
            size = os.path.getsize(dest)
            with open(dest, "rb") as f:
                head = f.read(3)
            is_img = head in (b"\x89PN", b"\xff\xd8\xff") or head[:3] == b"RIFF"
            print(f"OK {state}-{i:02d} {size}B {head.hex() if not is_img else 'img'}")
            if not is_img:
                failures.append(f"{state}-{i:02d}: not an image")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{state}-{i:02d}: {exc}")
            print(f"FAIL {state}-{i:02d}: {exc}")

print("FAILURES:", failures if failures else "none")
sys.exit(1 if failures else 0)
