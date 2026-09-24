"""Build fixed PR/docs labels from public Canopy snapshots; no model answers are read.

Reserved PRs are deliberately absent from training even though historical canopy-pr
already contains their titles and labels. Run before inspecting any holdout answers.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from anonymize import redact


HERE = Path(__file__).parent
ROOT = HERE.parents[2]
PR = {p["number"]: p for p in json.loads(Path("/tmp/canopy-data/prs_full.json").read_text())}
FILES = json.loads(Path("/tmp/canopy-data/pr_files.json").read_text())
HOLDOUT = (284, 285, 286, 287, 289)
assert set(HOLDOUT) == set(json.loads((ROOT / "eval/preset-holdout.json").read_text())["reserved_before_new_calibration"])

RULES = (
    "template.what-section", "template.why-section", "template.checklist",
    "template.what-concrete", "template.why-reason", "template.user-impact",
    "pr.title-specific", "pr.title-unfinished", "pr.description-what",
    "pr.description-why", "pr.description-testing", "pr.issue-reference",
    "pr.template-unfilled", "docs.behavior-change-without-docs",
    "docs.new-ipc-without-docs", "docs.new-error-variant-without-docs",
)


def row(n, labels):
    p = PR[n]
    return {
        "id": f"canopy-{n}", "source": f"https://github.com/itsoltech/canopy-desktop/pull/{n}",
        "pr": {"title": p["title"], "body": p.get("body") or ""},
        "files": FILES[str(n)],
        "labels": {k: {"violates": bool(v)} for k, v in labels.items()},
    }


# Frozen *before* any holdout API evaluation. 285 and 287 have no issue reference.
# No reserved PR has missing What/Why/checklist, unfinished title or uncovered
# user-visible behavior: 285 updates docs; 286 repairs an existing broken workflow;
# 284 is local build tooling; 287/289 replace aliases without changing UI behavior.
# 284 and 286 reference #283/#285; 289 references #287. 285 and 287 have none.
reserved = []
for n in HOLDOUT:
    labels = {k: False for k in RULES}
    labels["pr.issue-reference"] = n in (285, 287)
    reserved.append(row(n, labels))

# Existing historical PR labels are used only for the six template rules; exclude
# ALL versions of the five held-out PRs (including rejected revisions of 286/287).
original = [json.loads(line) for line in (ROOT / "eval/datasets/canopy-pr.jsonl").read_text().splitlines() if line]
training = []
for old in original:
    number = int(re.search(r"/pull/(\d+)$", old["source"]).group(1))
    if number in HOLDOUT:
        continue
    labels = {k: v for k, v in old["labels"].items() if k.startswith("template.")}
    if labels:
        training.append({
            "id": "history-" + old["id"], "source": old["source"],
            "pr": old["pr"], "labels": labels,
            **({"synthetic": old["synthetic"]} if "synthetic" in old else {}),
        })

# Existing deliberately constructed PR-description cases, kept separate from real PRs.
for line in (ROOT / "eval/datasets/pr-description.jsonl").read_text().splitlines():
    old = json.loads(line)
    old["id"] = "fixture-" + old["id"]
    training.append(old)

# Independently read PR descriptions and changed-file lists/diffs in /tmp/canopy-data.
# Explicitly label the *documentation obligation*, not just a regex match: new
# end-user features with no docs are positives; implementation-only IPC and typed
# error migrations are negatives. Changed docs make every docs rule negative.
# Every listed ID was inspected before calibration, rather than selected by Jev.
docs = {
    # number: (behavior without docs, new IPC without docs, new error variant without docs)
    1: (1, 1, 0), 12: (0, 0, 0), 55: (1, 1, 0),
    57: (1, 0, 0), 58: (1, 1, 0), 59: (1, 0, 0),
    64: (1, 1, 0), 65: (1, 0, 0), 66: (1, 1, 0),
    89: (1, 1, 0), 90: (1, 1, 1), 91: (0, 0, 0),
    94: (1, 1, 1), 97: (1, 1, 1), 126: (1, 1, 1),
    129: (1, 1, 1), 131: (1, 1, 0), 135: (1, 1, 1),
    146: (0, 0, 0), 151: (0, 0, 0), 170: (0, 0, 0),
    175: (1, 0, 0), 183: (0, 0, 0), 227: (0, 0, 0),
    238: (0, 0, 0), 241: (0, 0, 0), 262: (0, 0, 0),
    283: (0, 0, 0), 324: (0, 0, 0), 344: (0, 0, 0),
}
# Source-reading cross-checks: positives must have src changes and no docs changes;
# tagged variants must appear as added lines in an errors.ts source file.
for n, (behavior, ipc, error) in docs.items():
    files = FILES[str(n)]
    paths = [f["path"] for f in files]
    if behavior or ipc or error:
        assert any(p.startswith("src/") for p in paths) and not any(p.startswith("docs/") for p in paths), n
    if ipc:
        assert any(re.search(r"^\+.*\bipcMain\.handle\(\s*['\"]", f.get("patch") or "", re.M) for f in files if f["path"].startswith("src/")), n
    if error:
        assert any(re.search(r"^\+.*_tag:\s*['\"][A-Z]", f.get("patch") or "", re.M) for f in files if f["path"].endswith("/errors.ts")), n
    training.append(row(n, dict(zip(RULES[-3:], (behavior, ipc, error)))))

assert all(not re.search(r"/pull/(284|285|286|287|289)$", r.get("source", "")) for r in training)
for name, rows in (("train", training), ("holdout", reserved)):
    assert len({r["id"] for r in rows}) == len(rows)
    (HERE / f"{name}.jsonl").write_text("".join(json.dumps(redact(r), ensure_ascii=False) + "\n" for r in rows))
print("training rows", len(training), "holdout rows", len(reserved))
