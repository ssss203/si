#!/usr/bin/env python3
"""Prefix state frame paths in pet-spec.json to match subdirectory asset layout."""
import json
import sys

p = r"F:\ss_yong\si\pet-si\pet-spec.json"
spec = json.load(open(p, encoding="utf-8"))
for s in spec["states"]:
    s["frames"] = [f"{s['id']}/{f}" for f in s["frames"]]
with open(p, "w", encoding="utf-8") as f:
    json.dump(spec, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("frames updated:")
for s in spec["states"]:
    print(f"  {s['id']}: {s['frames'][0]} ... {len(s['frames'])} frames")
