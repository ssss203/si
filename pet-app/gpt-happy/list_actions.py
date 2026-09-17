import json

with open("pet-spec.json", encoding="utf-8") as f:
    s = json.load(f)

print("=== 互动入口(右键菜单) ===")
for it in s["experience"]["interactions"]:
    print(f"  {it['emoji']} {it['label']} -> 状态[{it['stateId']}] 时长{it['durationMs']}ms 好感+{it['affectionGain']}")

print()
print("=== 状态(动作) ===")
for st in s["states"]:
    n = len(st["frames"])
    first = st["frames"][0] if st["frames"] else ""
    folder = first.split("/")[0] if "/" in first else "-"
    print(f"  {st['id']:<18} 帧数:{n}  帧速:{st['frameDurationMs']}ms  loop:{st['loop']}  触发:{','.join(st['triggers'])}")
