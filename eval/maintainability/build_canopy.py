"""Build eval/datasets/canopy-maintainability.jsonl from canopy-desktop diffs and hand labels.

Rows come from two sources:

  labels-canopy.json    hunks from merged PRs that pass a rule's candidate_regex: every hunk Jev
                        scored 0.3 or more on a first run, plus a random sample of the rest, each
                        read and labeled by hand (violation / clean / unclear). "unclear" rows
                        expect insufficient_context.
  labels-reviewer.json  code the canopy review bot flagged for the same problem, as a window of the
                        file at the commit it commented on (diff_hunk stops at the commented line).

Usage: python3 eval/maintainability/build_canopy.py /tmp/canopy-data
"""

import base64
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from anonymize import redact


DATA = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/canopy-data")
HERE = Path(__file__).parent
OUT = HERE.parent / "datasets" / "canopy-maintainability.jsonl"
REPO = "itsoltech/canopy-desktop"

pr_files = json.loads((DATA / "pr_files.json").read_text())


def hunks(patch):
    return [p.rstrip("\n") for p in re.split(r"(?m)^(?=@@ )", patch or "") if p.startswith("@@ ")]


def added_line_number(hunk, text):
    """New-file line of the first added line containing `text`, if any."""
    line = int(re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", hunk).group(1)) - 1
    for raw in hunk.split("\n")[1:]:
        if raw.startswith("-"):
            continue
        line += 1
        if raw.startswith("+") and text and text.strip() in raw:
            return line
    return None


def label_of(item, hunk):
    label = {"violates": item["label"] == "violation"}
    if item["label"] == "unclear":
        label["expected"] = "insufficient_context"
    elif item["label"] == "clean":
        label["expected"] = "absent"
    else:
        label["expected"] = "present"
        line = added_line_number(hunk, item.get("line_text", ""))
        if line:
            label["line"] = line
    if item.get("reason"):
        label["note"] = item["reason"]
    return label


rows = {}
for item in json.loads((HERE / "labels-canopy.json").read_text())["items"]:
    files = {f["path"]: f for f in pr_files[str(item["pr"])]}
    hunk = hunks(files[item["path"]]["patch"])[item["hunk"]]
    rid = f"canopy-pr{item['pr']}-{Path(item['path']).stem}-{item['hunk']}"
    row = rows.setdefault(rid, {
        "id": rid,
        "source": f"https://github.com/{REPO}/pull/{item['pr']}/files",
        "path": item["path"],
        "patch": hunk,
        "labels": {},
    })
    row["labels"][item["rule"]] = label_of(item, hunk)

for item in json.loads((HERE / "labels-reviewer.json").read_text())["items"]:
    raw = subprocess.check_output(
        ["gh", "api", f"repos/{REPO}/contents/{item['path']}?ref={item['commit']}", "--jq", ".content"]
    )
    lines = base64.b64decode(raw).decode().split("\n")[item["start"] - 1 : item["end"]]
    patch = f"@@ -0,0 +{item['start']},{len(lines)} @@\n" + "\n".join("+" + l for l in lines)
    rid = f"canopy-review-{item['comment']}"
    rows[rid] = {
        "id": rid,
        "source": f"https://github.com/{REPO}/pull/{item['pr']}#discussion_r{item['comment']}",
        "path": item["path"],
        "patch": patch,
        "labels": {item["rule"]: label_of(item, patch)},
    }

with OUT.open("w") as f:
    for row in rows.values():
        f.write(json.dumps(redact(row), ensure_ascii=False) + "\n")
print(f"{len(rows)} rows written to {OUT}")
