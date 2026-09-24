"""List rows where Jev disagrees with the hand label, from a calibrate --dump file.

  python3 eval/maintainability/disagreements.py <dataset.jsonl> <dump.jsonl> [threshold]

New dumps use production decisions, including confidence. Human review on known clean rows,
unknown labels, missing evaluations and model-option disagreements are listed separately.
The optional threshold is only for legacy dumps without a decision status.
"""

import json
import sys

dataset_path, dump_path = sys.argv[1], sys.argv[2]
threshold = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
rows = {r["id"]: r for r in map(json.loads, open(dataset_path))}
samples = [json.loads(l) for l in open(dump_path) if l.strip()]

groups = {"false positive": [], "needs human (violation)": [], "needs human (clean)": [], "missed": [], "unknown finding": [], "incomplete": [], "other answer": []}
for s in samples:
    label = rows[s["row"]]["labels"][s["rule"]]
    status = s.get("status")
    fired = status == "confirmed" if status else s["score"] >= threshold
    if s.get("missing"):
        groups["incomplete"].append(s)
    if s["truth"] is None and (fired or status == "needs_human"):
        groups["unknown finding"].append(s)
    elif fired and s["truth"] is False:
        groups["false positive"].append(s)
    elif status == "needs_human" and s["truth"] is not None:
        groups["needs human (violation)" if s["truth"] else "needs human (clean)"].append(s)
    elif s["truth"] and not fired:
        groups["missed"].append(s)
    elif label.get("expected") and s.get("choice") and s["choice"] != label["expected"]:
        groups["other answer"].append(s)

for name, items in groups.items():
    print(f"\n## {name} ({len(items)})")
    for s in sorted(items, key=lambda x: (x["rule"], -x["score"])):
        row = rows[s["row"]]
        label = row["labels"][s["rule"]]
        choice = s.get("choice", s.get("status", "not asked"))
        print(f"- {s['rule']} {s['row']} score {s['score']:.3f} decision {s.get('status', 'legacy threshold')} answer {choice} expected {label.get('expected', '-')}")
        print(f"  {row['path']}  {row.get('source', '')}")
        if label.get("note"):
            print(f"  label: {label['note']}")
