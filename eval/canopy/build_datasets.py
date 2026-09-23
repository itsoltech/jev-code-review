"""Build labeled datasets from itsoltech/canopy-desktop history.

Inputs (fetched with gh, see eval/canopy/README.md) in DATA_DIR:
  prs_full.json        merged PRs with title/body edit history (GraphQL)
  pr_files.json        {pr_number: [{path, status, additions, deletions, patch}]}
  review_comments.json inline review comments (REST, paginated)
  issue_comments.json  PR conversation comments (REST, paginated)

Output: eval/datasets/canopy-pr.jsonl, PR title/description rows labeled from the pr-validation
bot, with manual corrections from label-overrides.json. Code rows are built by
build_code_dataset.py from hand labels.

Labels come from the repository's own review history, not from hand labeling, so they carry
that bot's mistakes. The calibration report lists disagreements for manual inspection.
"""

import json
import random
import re
import sys
from pathlib import Path

DATA = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/canopy-data")
OUT = Path(__file__).resolve().parents[1] / "datasets"
random.seed(7)


def load_paginated(name):
    text = (DATA / name).read_text()
    return json.loads("[" + text.replace("][", ",")[1:-1] + "]")


prs = {p["number"]: p for p in json.loads((DATA / "prs_full.json").read_text())}
pr_files = {int(k): v for k, v in json.loads((DATA / "pr_files.json").read_text()).items()}
review_comments = load_paginated("review_comments.json")
issue_comments = load_paginated("issue_comments.json")

BOTS = {"dependabot", "dependabot[bot]"}
PR_RULES = [
    "title.infra-not-user-facing", "title.prefix", "title.length", "title.lowercase", "title.period",
    "template.what-section", "template.why-section", "template.checklist",
    "template.what-concrete", "template.why-reason", "template.user-impact",
]


def pr_number(url):
    return int(url.rstrip("/").split("/")[-1])


def labels_of(pr):
    return {l["name"] for l in pr["labels"]["nodes"]}


def version_at(pr, when):
    """Title and body as they were at time `when` (ISO string), from rename and edit history."""
    title = pr["title"]
    for r in sorted(pr["timelineItems"]["nodes"], key=lambda r: r["createdAt"]):
        if r["createdAt"] > when:
            title = r["previousTitle"]
            break
    # GraphQL returns edits newest first. The original body is recorded with the same timestamp
    # as the first edit, so keep the API order instead of sorting by time.
    edits = list(reversed(pr["userContentEdits"]["nodes"]))
    body = pr["body"]
    if edits:
        # The oldest edit holds the body as first posted; each later edit holds the body after it.
        before = [e for e in edits if e["createdAt"] <= when]
        body = (before[-1] if before else edits[0])["diff"] or ""
    return title, body


# Manually reviewed: feat/fix PRs that change only CI, tooling or dependency files.
INFRA_AS_FEAT = {15, 78, 121, 284}


def files_of(n):
    return [{"path": f["path"], "status": f["status"], "additions": f["additions"], "deletions": f["deletions"]} for f in pr_files.get(n, [])]


def failures_from_comment(body):
    """Map pr-validation bot bullets to rule ids."""
    fired = set()
    for kind, text in re.findall(r"^- \*\*(\w+)\*\*: (.*)$", body, re.M):
        t = text.lower()
        if kind == "Title":
            if re.search(r"must start with|is not allowed|conventional commit prefix", t):
                fired.add("title.prefix")
            if "72" in t:
                fired.add("title.length")
            if "lowercase" in t:
                fired.add("title.lowercase")
            if "period" in t:
                fired.add("title.period")
        elif kind == "Description":
            if '"what"' in t:
                fired.add("template.what-section")
            if '"why"' in t and "user impact" in t and "missing" not in t and "empty" not in t:
                fired.add("template.user-impact")
            elif '"why"' in t:
                fired.add("template.why-section")
        elif kind == "Checklist":
            fired.add("template.checklist")
    return fired


# ---------------------------------------------------------------- PR title/description rows
pr_rows = []
validation = {}
for c in issue_comments:
    if c["user"]["login"] == "claude[bot]" and "### PR validation" in c["body"]:
        validation.setdefault(pr_number(c["issue_url"]), []).append(c)

for n, pr in sorted(prs.items()):
    # pr-validation skips bot authors (Claude app, dependabot) and passes them without checking.
    if (pr["author"] or {}).get("__typename") == "Bot" or (pr["author"] or {}).get("login") in BOTS:
        continue
    passed = "claude:pr-validation:passed" in labels_of(pr)
    comments = sorted(validation.get(n, []), key=lambda c: c["created_at"])
    if not passed and not comments:
        continue  # validation never ran on this PR
    for i, c in enumerate(comments):
        title, body = version_at(pr, c["created_at"])
        fired = failures_from_comment(c["body"])
        if n in INFRA_AS_FEAT and re.match(r"(feat|fix)\b", title):
            fired.add("title.infra-not-user-facing")
        pr_rows.append({
            "id": f"pr{n}-rejected-{i + 1}",
            "source": f"https://github.com/itsoltech/canopy-desktop/pull/{n}",
            "pr": {"title": title, "body": body},
            "files": files_of(n),
            "labels": {r: {"violates": r in fired} for r in PR_RULES},
        })
    if passed:
        pr_rows.append({
            "id": f"pr{n}-final",
            "source": f"https://github.com/itsoltech/canopy-desktop/pull/{n}",
            "pr": {"title": pr["title"], "body": pr["body"]},
            "files": files_of(n),
            "labels": {r: {"violates": r == "title.infra-not-user-facing" and n in INFRA_AS_FEAT and bool(re.match(r"(feat|fix)\b", pr["title"]))} for r in PR_RULES},
        })


def section(body, name):
    m = re.search(rf"^#+\s*{name}\s*$\n(.*?)(?=^#+\s|\Z)", body, re.M | re.S | re.I)
    return re.sub(r"<!--.*?-->", "", m.group(1), flags=re.S).strip() if m else ""


def replace_section(body, name, text):
    return re.sub(rf"(^#+\s*{name}\s*$\n)(.*?)(?=^#+\s|\Z)", lambda m: m.group(1) + text + "\n\n", body, count=1, flags=re.M | re.S | re.I)


# Harder content cases built from real descriptions: the section exists and has text, but the
# text does not do its job. Only the targeted rule is labeled.
finals = [r for r in pr_rows if r["id"].endswith("-final") and section(r["pr"]["body"], "what") and section(r["pr"]["body"], "why")]
random.shuffle(finals)
refactor_whys = [section(r["pr"]["body"], "why") for r in finals if r["pr"]["title"].startswith(("refactor", "chore", "build"))]
for r in finals[:15]:
    body = r["pr"]["body"]
    what, why = section(body, "what"), section(body, "why")
    pr_rows.append({"id": r["id"].replace("-final", "-why-is-what"), "source": r["source"], "files": r["files"], "synthetic": "Why replaced with the What text",
                    "pr": {"title": r["pr"]["title"], "body": replace_section(body, "why", what)},
                    "labels": {"template.why-reason": {"violates": True}}})
for r, filler in zip(finals[15:27], ["TBD", "-", "See title.", "Various fixes and improvements.", "WIP", "Changes.", "n/a", "Refactor.", "Update code", "Fixes", "misc", "See #123"]):
    body = r["pr"]["body"]
    pr_rows.append({"id": r["id"].replace("-final", "-vague-what"), "source": r["source"], "files": r["files"], "synthetic": f'What replaced with "{filler}"',
                    "pr": {"title": r["pr"]["title"], "body": replace_section(body, "what", filler)},
                    "labels": {"template.what-concrete": {"violates": True}}})
feats = [r for r in finals if r["pr"]["title"].startswith("feat")]
for r, why in zip(feats[:12], refactor_whys * 3):
    pr_rows.append({"id": r["id"].replace("-final", "-feat-internal-why"), "source": r["source"], "files": r["files"], "synthetic": "feat Why replaced with a refactor PR's Why",
                    "pr": {"title": r["pr"]["title"], "body": replace_section(r["pr"]["body"], "why", why)},
                    "labels": {"template.user-impact": {"violates": True}}})

# Manually verified corrections, with the reason for each.
overrides = json.loads((Path(__file__).parent / "label-overrides.json").read_text())
for row in pr_rows:
    for rule, fix in overrides.get(row["id"], {}).items():
        row["labels"][rule] = {"violates": fix["violates"], "override": fix["reason"]}

# Names of other projects that appear in canopy's public PR text are replaced before saving.
REDACT = [(re.compile(r"gakko", re.I), "ExampleProject")]


def redact(value):
    if isinstance(value, str):
        for pattern, replacement in REDACT:
            value = pattern.sub(replacement, value)
        return value
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    return value


OUT.mkdir(parents=True, exist_ok=True)
with open(OUT / "canopy-pr.jsonl", "w") as f:
    for r in pr_rows:
        f.write(json.dumps(redact(r), ensure_ascii=False) + "\n")

print(f"canopy-pr.jsonl: {len(pr_rows)} rows")
for rule in PR_RULES:
    pos = sum(1 for r in pr_rows if r["labels"].get(rule, {}).get("violates"))
    tot = sum(1 for r in pr_rows if rule in r["labels"])
    print(f"  {rule}: {pos} positive / {tot}")
