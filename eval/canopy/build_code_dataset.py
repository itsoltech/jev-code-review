"""Build eval/datasets/canopy-code.jsonl from canopy-desktop diffs and hand labels.

  errors.try-catch-outside-boundaries     every added try/catch hunk in src/main (outside ipc/, tests,
                                 errors.ts), labeled by reading, see labels-try-catch.json
  svelte.effect-without-cleanup  every added Svelte $effect in src/renderer. Canopy's effects
                                 almost always clean up, so each effect that creates a listener,
                                 timer, observer or subscription is paired with a copy whose
                                 cleanup `return` was removed (violation by construction).
                                 Effects that create nothing are negatives.

Usage: python3 eval/canopy/build_code_dataset.py /tmp/canopy-data
"""

import json
import random
import re
import sys
from fnmatch import fnmatch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from anonymize import redact


DATA = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/canopy-data")
HERE = Path(__file__).parent
OUT = HERE.parent / "datasets" / "canopy-code.jsonl"
random.seed(11)

pr_files = json.loads((DATA / "pr_files.json").read_text())


def hunks(patch):
    return [p.rstrip("\n") for p in re.split(r"(?m)^(?=@@ )", patch or "") if p.startswith("@@ ")]


def right_line_numbers(hunk):
    """New-file line number for each body line of a hunk (None for deleted lines)."""
    start = int(re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", hunk).group(1))
    out, line = [], start - 1
    for raw in hunk.split("\n")[1:]:
        if raw.startswith("-"):
            out.append(None)
        else:
            line += 1
            out.append(line)
    return out


rows = []

# ------------------------------------------------------------------ try/catch
labels = json.loads((HERE / "labels-try-catch.json").read_text())
for item in labels["items"]:
    if item["label"] == "skip":
        continue
    files = {f["path"]: f for f in pr_files[str(item["pr"])]}
    hunk = hunks(files[item["path"]]["patch"])[item["hunk"]]
    body = hunk.split("\n")[1:]
    label = {"violates": item["label"] == "violation"}
    if label["violates"]:
        tries = [j for j, l in enumerate(body) if l.startswith("+") and re.search(r"\btry\s*\{", l)]
        if not tries:
            tries = [j for j, l in enumerate(body) if l.startswith("+") and re.search(r"\}\s*catch\b", l)]
        start = tries[min(item.get("try_index", 0), len(tries) - 1)]
        numbers = right_line_numbers(hunk)
        # The finding is the whole try/catch block: accept any line from `try` to the catch body.
        catch = next((k for k in range(start, len(body)) if re.search(r"\}\s*catch\b", body[k])), start)
        label["line"] = numbers[start]
        label["line_range"] = [numbers[start], numbers[min(catch + 4, len(body) - 1)] or numbers[start]]
    if item.get("note"):
        label["note"] = item["note"]
    rows.append({
        "id": f"try-pr{item['pr']}-{Path(item['path']).stem}-{item['hunk']}",
        "source": f"https://github.com/itsoltech/canopy-desktop/pull/{item['pr']}/files",
        "path": item["path"],
        "patch": hunk,
        "labels": {"errors.try-catch-outside-boundaries": label},
    })

# ------------------------------------------------------------------ $effect
RESOURCE = re.compile(
    r"addEventListener|setInterval|setTimeout|\.subscribe\(|window\.\w+\.on[A-Z]\w*\(|"
    r"ipcRenderer\.on\(|new (ResizeObserver|IntersectionObserver|MutationObserver)"
)
# Read and excluded: the subscription is cleaned up but a timer created in its callback is not
# (arguable), and a one-shot requestAnimationFrame the rule does not name.
SKIP = [r"notchApi\.onStateUpdate", r"keyboardOpen"]


def effect_bodies(hunk):
    """Complete added $effect blocks in a hunk, as lists of code lines without the + marker."""
    lines = hunk.split("\n")[1:]
    out = []
    for j, l in enumerate(lines):
        if not (l.startswith("+") and re.match(r"\s*\$effect\(", l[1:])):
            continue
        indent = len(l[1:]) - len(l[1:].lstrip())
        body = [l[1:]]
        for m in lines[j + 1:]:
            if not m.startswith("+"):
                body = None  # mixes old and new code; the effect is not fully added here
                break
            body.append(m[1:])
            t = m[1:]
            if t.strip().startswith("})") and len(t) - len(t.lstrip()) == indent:
                break
        else:
            body = None
        if body and len(body) <= 60:
            out.append(body)
    return out


def remove_cleanup(body):
    """Drop the effect's cleanup return. None when there is no single cleanup return to remove."""
    indent = len(body[0]) - len(body[0].lstrip()) + 2
    for j in range(len(body) - 1, 0, -1):
        line = body[j]
        if len(line) - len(line.lstrip()) != indent or not line.lstrip().startswith("return"):
            continue
        text = line.strip()
        if re.fullmatch(r"return \(\) => \{", text):
            end = next(k for k in range(j + 1, len(body)) if body[k].strip() == "}" and len(body[k]) - len(body[k].lstrip()) == indent)
            return body[:j] + body[end + 1:]
        if re.fullmatch(r"return \(\) => .+", text) or re.fullmatch(r"return \w+", text):
            return body[:j] + body[j + 1:]
        if re.match(r"return window\.\w+\.on[A-Z]", text):
            return body[:j] + [line.replace("return ", "", 1)] + body[j + 1:]
        return None
    return None


def as_patch(body):
    return f"@@ -0,0 +1,{len(body)} @@\n" + "\n".join("+" + l for l in body)


effect_rows, plain = [], []
for pr, files in pr_files.items():
    for f in files:
        path = f["path"]
        if f["status"] == "removed" or not path.startswith("src/renderer") or not path.endswith((".svelte", ".svelte.ts")):
            continue
        for h, hunk in enumerate(hunks(f["patch"])):
            for e, body in enumerate(effect_bodies(hunk)):
                text = "\n".join(body)
                if any(re.search(s, text) for s in SKIP):
                    continue
                base = {"source": f"https://github.com/itsoltech/canopy-desktop/pull/{pr}/files", "path": path}
                key = f"effect-pr{pr}-{Path(path).name.split('.')[0]}-{h}-{e}"
                if not RESOURCE.search(text):
                    plain.append({**base, "id": key, "patch": as_patch(body),
                                  "labels": {"svelte.effect-without-cleanup": {"violates": False, "note": "creates no listener, timer or subscription"}}})
                    continue
                effect_rows.append({**base, "id": key, "patch": as_patch(body),
                                    "labels": {"svelte.effect-without-cleanup": {"violates": False, "note": "real effect, returns cleanup"}}})
                mutant = remove_cleanup(body)
                if mutant:
                    line = next(k for k, l in enumerate(mutant) if RESOURCE.search(l) and "typeof" not in l) + 1
                    effect_rows.append({**base, "id": key + "-nocleanup", "patch": as_patch(mutant), "synthetic": "cleanup return removed",
                                        "labels": {"svelte.effect-without-cleanup": {"violates": True, "line": line}}})

# Identical effects repeat across PRs (the same code re-diffed); keep one of each.
seen, unique = set(), []
for r in effect_rows + plain:
    if r["patch"] in seen:
        continue
    seen.add(r["patch"])
    unique.append(r)
random.shuffle(unique)
rows += [r for r in unique if r["labels"]["svelte.effect-without-cleanup"]["note" if "note" in r["labels"]["svelte.effect-without-cleanup"] else "violates"] != "creates no listener, timer or subscription"]
rows += [r for r in unique if r["labels"]["svelte.effect-without-cleanup"].get("note") == "creates no listener, timer or subscription"][:25]

# ------------------------------------------------------------------ snippet labels
# labels-*.json files whose items carry the code itself (a handler, a component block).
for labels_file in sorted(HERE.glob("labels-*.json")):
    data = json.loads(labels_file.read_text())
    items = [i for i in data["items"] if "code" in i]
    for n, item in enumerate(items):
        code = item["code"].split("\n")
        label = {"violates": item["label"] == "violation", "note": item["note"]}
        rows.append({
            "id": f"{labels_file.stem.removeprefix('labels-')}-pr{item['pr']}-{Path(item['path']).stem}-{n}",
            "source": f"https://github.com/itsoltech/canopy-desktop/pull/{item['pr']}/files",
            "path": item["path"],
            "patch": as_patch(code),
            **({"synthetic": item["synthetic"]} if item.get("synthetic") else {}),
            "labels": {data["rule"]: label},
        })


OUT.write_text("".join(json.dumps(redact(r), ensure_ascii=False) + "\n" for r in rows))
for rule in sorted({k for r in rows for k in r["labels"]}):
    pos = sum(1 for r in rows if r["labels"].get(rule, {}).get("violates") is True)
    neg = sum(1 for r in rows if r["labels"].get(rule, {}).get("violates") is False)
    print(f"{rule}: {pos} violations, {neg} clean")
