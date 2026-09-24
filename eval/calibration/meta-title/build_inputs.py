#!/usr/bin/env python3
"""Build independent title/style/dimension slices from public canopy PR exports.

Run after fetching /tmp/canopy-data. Frozen holdout labels are read, never inferred
from eval/datasets/canopy-pr.jsonl. Source mutations are explicitly tagged.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from anonymize import redact


HERE = Path(__file__).parent
DATA = Path('/tmp/canopy-data')
HELD = {284, 285, 286, 287, 289}
TITLE_IDS = ['title.prefix', 'title.length', 'title.lowercase', 'title.period', 'title.infra-not-user-facing']
prs = {pr['number']: pr for pr in json.loads((DATA / 'prs_full.json').read_text())}
files = json.loads((DATA / 'pr_files.json').read_text())
hold = json.loads((HERE / 'holdout-labels.json').read_text())

def save(name, rows):
    if len(sys.argv) > 1 and sys.argv[1] != name: return
    (HERE / name).write_text(''.join(json.dumps(redact(row), ensure_ascii=False) + '\n' for row in rows))
    print(name, len(rows))


def subset(n, path):
    return next(f for f in files[str(n)] if f['path'] == path)


def hunk(n, path, needle=None):
    chunks = re.split(r'(?=^@@ )', subset(n, path)['patch'], flags=re.M)
    selected = next((chunk for chunk in chunks if chunk.startswith('@@ ') and (needle is None or needle in chunk)), None)
    if selected is None:
        raise ValueError(f'No hunk {n} {path} {needle}')
    return selected


def code_row(n, path, needle, name, violation, rubric, mutation=None):
    patch = hunk(n, path, needle)
    if mutation:
        for old, new in mutation:
            if old not in patch: raise ValueError(f'No mutation target {old}')
            patch = patch.replace(old, new)
    return dict(id=name, source=f'https://github.com/itsoltech/canopy-desktop/pull/{n}', provenance='real PR hunk' if not mutation else f'source-derived mutation of real PR hunk: {mutation}', path=path, patch=patch, labels={'style.naming': {'violates': violation}}, readability_expected=rubric)


orig = [json.loads(s) for s in Path('eval/datasets/canopy-pr.jsonl').read_text().splitlines()]
training = []
for row in orig:
    if int(row['id'].split('-')[0][2:]) in HELD: continue
    title_labels = {k: {'violates': row['labels'][k]['violates']} for k in TITLE_IDS if k in row['labels']}
    if title_labels:
        training.append({**{k: v for k, v in row.items() if k != 'labels'}, 'labels': title_labels})
# Hard examples derived from titles, not purported independent PRs. Do not tune on held PRs.
sources = [(55, 'feat(browser): migrate to webview, add credentials, favorites, viewports, and device emulation'), (66, 'feat: add task tracker integrations (Jira & YouTrack)'), (262, 'refactor(terminal): replace local websocket bridge with ipc')]
for n, title in sources:
    if prs[n]['title'] != title: raise ValueError(f'title changed for PR {n}')
    for kind, derived in [('period', title + '.'), ('uppercase', title.split(': ', 1)[0] + ': ' + title.split(': ', 1)[1][0].upper() + title.split(': ', 1)[1][1:])]:
        training.append(dict(id=f'mutation-pr{n}-{kind}', source=f'https://github.com/itsoltech/canopy-desktop/pull/{n}', provenance='source-derived title mutation', pr={'title': derived}, files=files[str(n)], labels={k: {'violates': k == ('title.period' if kind == 'period' else 'title.lowercase') or (k == 'title.length' and len(derived) >= 72)} for k in TITLE_IDS}))
# Hard negative: valid prefix in the infra-only path must be chore; unrecognized path like src/ is not infra-only.
training.append(dict(id='mutation-pr55-infra-title', source='https://github.com/itsoltech/canopy-desktop/pull/55', provenance='source-derived path/title mutation', pr={'title': 'feat: upgrade release workflow'}, files=[{'path': '.github/workflows/release.yml', 'status': 'modified', 'additions': 1, 'deletions': 0, 'patch': '@@ -1,0 +1 @@\n+name: release'}], labels={k: {'violates': k == 'title.infra-not-user-facing'} for k in TITLE_IDS}))
training.append(dict(id='mutation-pr55-infra-chore', source='https://github.com/itsoltech/canopy-desktop/pull/55', provenance='source-derived path/title mutation', pr={'title': 'chore: upgrade release workflow'}, files=[{'path': '.github/workflows/release.yml', 'status': 'modified', 'additions': 1, 'deletions': 0, 'patch': '@@ -1,0 +1 @@\n+name: release'}], labels={k: {'violates': False} for k in TITLE_IDS}))
save('title-train.jsonl', training)
held = []
for n in sorted(HELD):
    p = prs[n]
    held.append(dict(id=f'holdout-pr{n}', source=f'https://github.com/itsoltech/canopy-desktop/pull/{n}', pr={'title': p['title'], 'body': p['body'] or ''}, files=files[str(n)], labels={k: {'violates': v} for k,v in hold['title'][str(n)].items()}))
save('title-holdout.jsonl', held)

style = [
    code_row(135,'src/main/skills/SkillInstaller.ts','const tmp =','pr135-tmp-prefix',False,3),
    code_row(33,'src/renderer/src/components/preferences/GeminiPrefs.svelte','const obj:','pr33-object-accumulator',False,2),
    code_row(3,'src/main/browser/BrowserManager.ts','const x = Math.min','pr3-coordinate-short-names',False,2),
    code_row(66,'src/main/taskTracker/providers/jira.ts','const data = await jiraFetch','pr66-response-data',False,2),
    code_row(262,'src/main/pty/TerminalStreamService.ts','const data = chunk.data.slice','pr262-buffer-data',False,3),
]
style += [
    code_row(135,'src/main/skills/SkillInstaller.ts','const tmp =','mutation-pr135-misleading-tmp',True,1,(('const tmp = normalize(tmpdir()) + sep', 'const permanentUserDataDirectory = normalize(tmpdir()) + sep'), ('resolved.startsWith(tmp)', 'resolved.startsWith(permanentUserDataDirectory)'))),
    code_row(262,'src/main/pty/TerminalStreamService.ts','const data = chunk.data.slice','mutation-pr262-misleading-data',True,1,(('const data = chunk.data.slice', 'const fullUntrimmedStream = chunk.data.slice'), ('this.sendData(subscriber.subscriptionId, requestedOffset, data)', 'this.sendData(subscriber.subscriptionId, requestedOffset, fullUntrimmedStream)'))),
]
save('style-train-corrected.jsonl', style)
style_hold = [code_row(x['pr'],x['path'],None,f"holdout-pr{x['pr']}-{x['path'].split('/')[-1]}",x['naming_violation'],x['expected_readability']) for x in hold['style_hunks']]
save('style-holdout.jsonl', style_hold)
focus = {55:1,60:1,66:3,149:1,262:3,3:2}
focus_train = [dict(id=f'focus-pr{n}', source=f'https://github.com/itsoltech/canopy-desktop/pull/{n}', pr={'title':prs[n]['title'], 'body':prs[n]['body'] or ''}, files=files[str(n)], expected_score=score) for n,score in focus.items()]
focus_hold = [dict(id=f'focus-pr{n}', source=f'https://github.com/itsoltech/canopy-desktop/pull/{n}', pr={'title':prs[n]['title'], 'body':prs[n]['body'] or ''}, files=files[str(n)], expected_score=hold['change_focus'][str(n)]) for n in sorted(HELD)]
save('focus-train.jsonl', focus_train)
save('focus-holdout.jsonl', focus_hold)
