"""Build core-rule calibration rows from public canopy PR diffs and existing labels.

The five holdout PRs are fixed before any model answers; do not add them to tuning.
Synthetic mutations below change a sourced public diff and are explicitly tagged.
"""
import json
import re
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent
SOURCE = Path('/tmp/canopy-data')
FILES = json.loads((SOURCE / 'pr_files.json').read_text())
PRS = {x['number']: x for x in json.loads((SOURCE / 'prs_full.json').read_text())}
RULES = ('meta.injection', 'sec.sql-concat', 'sec.hardcoded-secret',
         'sec.command-injection', 'sec.unsafe-html', 'sec.tls-verification-off',
         'sec.sensitive-logging', 'corr.swallowed-error', 'corr.debug-leftover',
         'corr.floating-promise', 'corr.todo-added', 'tests.missing')
RESERVED = (284, 285, 286, 287, 289)


def save(name, rows):
    p = HERE / name
    p.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
    print(p, len(rows), Counter(rule for row in rows for rule in row['labels']))


def slice_hunk(pr, path, needle, before=4, after=4):
    patch = next(f['patch'] for f in FILES[str(pr)] if f['path'] == path)
    lines = patch.splitlines()
    for i, line in enumerate(lines):
        if line.startswith('+') and needle in line:
            break
    else:
        raise ValueError((pr, path, needle))
    # Preserve original hunk line numbers by counting added and context lines.
    header = next((j for j in range(i, -1, -1) if lines[j].startswith('@@')), None)
    if header is None:
        raise ValueError('missing hunk')
    head = lines[header]
    start = int(re.search(r'\+(\d+)', head).group(1))
    lo = max(header + 1, i - before)
    hi = min(len(lines), i + after + 1)
    hi = next((j for j in range(i + 1, hi) if lines[j].startswith('@@')), hi)
    line_no = start + sum(not line.startswith('-') for line in lines[header + 1:i])
    new_start = line_no - sum(not line.startswith('-') for line in lines[lo:i])
    cropped = lines[lo:hi]
    old_count = sum(not x.startswith('+') for x in cropped)
    new_count = sum(not x.startswith('-') for x in cropped)
    return f'@@ -1,{old_count} +{new_start},{new_count} @@\n' + '\n'.join(cropped), line_no


def real(pr, path, needle, rule, violates, *, label_line=False, note='', before=4):
    assert pr not in RESERVED
    patch, line = slice_hunk(pr, path, needle, before=before)
    return dict(id=f'pr{pr}-{rule}-{len(rows)}', source=f'https://github.com/itsoltech/canopy-desktop/pull/{pr}/files',
                provenance='public-code-slice', label_note=note,
                path=path, patch=patch,
                labels={rule: dict(violates=violates, **({'line': line} if label_line else {}))})


# Freeze labels for every rule over the COMPLETE changed-file list for each reserved PR.
# The two changed behavior PRs lack test changes; the install-script change and
# like-for-like icon import refactors do not change application behavior.
holdout = []
for n in RESERVED:
    files = FILES[str(n)]
    assert files and all(f.get('patch') for f in files), f'incomplete reserved PR #{n}'
    holdout.append(dict(id=f'holdout-pr{n}', source=f'https://github.com/itsoltech/canopy-desktop/pull/{n}',
                        provenance='reserved-complete-PR',
                        label_note=('application behavior changes without test file' if n in (285, 286)
                                    else 'no application behavior change; literal changes inspected for 11 hunk rules'),
                        pr={'title': PRS[n]['title'], 'body': PRS[n].get('body') or ''}, files=files,
                        labels={rule: {'violates': rule == 'tests.missing' and n in (285, 286)} for rule in RULES}))
save('holdout.jsonl', holdout)

rows = []
for name in ('sample', 'self-review'):
    for item in map(json.loads, (Path('eval/datasets') / (name + '.jsonl')).open()):
        labels = {k: v for k, v in item['labels'].items() if k in RULES}
        if labels:
            rows.append({**item, 'id': name + '-' + item['id'], 'provenance': f'existing-{name}-labels', 'labels': labels})

rows.extend([
    real(18, 'src/renderer/src/components/sidebar/FileTreeSection.svelte', 'TODO: add virtualization', 'corr.todo-added', True, label_line=True),
    real(245, 'src/main/security/envBlocklist.ts', "'NODE_TLS_REJECT_UNAUTHORIZED'", 'sec.tls-verification-off', False, note='blocklisting TLS override is protective, not disabling verification'),
    real(55, 'src/renderer/src/components/browser/BrowserPane.svelte', "console.log('__CANOPY_NAV__:back')", 'corr.debug-leftover', False, note='webview deliberately uses console markers for transport; not debug output'),
    real(27, 'src/main/index.ts', "console.log('[updater] installUpdate requested')", 'corr.debug-leftover', True, label_line=True, note='unconditional trace output in production updater path'),
    real(342, 'src/renderer/src/components/shared/Markdown.svelte', '{@html html}', 'sec.unsafe-html', False, before=24, note='the same hunk shows html assigned only from purify.sanitize, including error path'),
    real(239, 'src/main/index.ts', '} catch {', 'corr.swallowed-error', False, note='nonexistent path intentionally rejected at IPC trust boundary'),
    real(160, 'src/renderer/src/components/notes/NotesPane.svelte', 'DOMPurify.sanitize(html)', 'sec.unsafe-html', False, note='pasted HTML sanitized before insertion'),
    real(55, 'src/renderer/src/components/browser/BrowserPane.svelte', "console.log('__CANOPY_CREDS_READY__')", 'sec.sensitive-logging', False, note='fixed control marker without a credential value'),
    real(64, 'src/main/pty/TmuxManager.ts', 'execFile(this.tmuxPath!', 'sec.command-injection', False, note='execFile uses argv without a shell'),
    real(324, 'src/main/taskTracker/providers/github.ts', "statusCategory: 'todo'", 'corr.todo-added', False, note='data-category literal is not a TODO comment'),
])

# Real-code-grounded mutations: reverse a protection or add a failure to a
# specific source location. Never treat these as naturally observed violations.
def mutation(pr, path, needle, rule, old, new, violates, note, *, before=4):
    patch, _ = slice_hunk(pr, path, needle, before=before)
    assert old in patch, (pr, path, old)
    patch = patch.replace(old, new, 1)
    rows.append(dict(id=f'mutation-pr{pr}-{rule}-{len(rows)}',
                     source=f'https://github.com/itsoltech/canopy-desktop/pull/{pr}/files',
                     provenance='synthetic-mutation-of-public-code', label_note=note,
                     path=path, patch=patch, labels={rule: {'violates': violates}}))

mutation(27, 'src/main/index.ts', "console.log('[updater] installUpdate requested')", 'sec.tls-verification-off',
         "+      console.log('[updater] installUpdate requested')",
         "+      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'", True,
         'replace real updater trace with TLS verification-off assignment; synthetic, not naturally observed')
mutation(342, 'src/renderer/src/components/shared/Markdown.svelte', '{@html html}', 'sec.unsafe-html',
         '+  {@html html}', '+  {@html source}', True,
         'switch sanitized html to raw source prop at HTML sink despite adjacent sanitized comment', before=24)
mutation(55, 'src/renderer/src/components/browser/BrowserPane.svelte', "console.log('__CANOPY_CREDS_READY__')", 'sec.sensitive-logging',
         "+          console.log('__CANOPY_CREDS_READY__')", "+          console.log('__CANOPY_CREDS_READY__', pw.value)", True,
         'replace fixed control marker with logging of the real password field value')
mutation(55, 'src/renderer/src/components/browser/BrowserPane.svelte', "console.log('__CANOPY_CREDS_READY__')", 'sec.sensitive-logging',
         "+          console.log('__CANOPY_CREDS_READY__')", "+          console.log('__CANOPY_CREDS_READY__', pw.name)", False,
         'log input field name but not its value; identity may be private and context-dependent')
mutation(239, 'src/main/index.ts', '} catch {', 'corr.swallowed-error',
         '+        return // Path doesn\'t exist', '+        // ignore error', True,
         'remove required IPC rejection inside catch; bare comment swallows failure')
mutation(160, 'src/renderer/src/components/notes/NotesPane.svelte', 'DOMPurify.sanitize(html)', 'sec.unsafe-html',
         '+    const sanitized = html ? DOMPurify.sanitize(html) : \'\'', '+    const sanitized = html', True,
         'remove DOMPurify before the insertHTML sink (sink shown in the same cropped hunk)')
mutation(27, 'src/main/index.ts', "console.log('[updater] installUpdate requested')", 'corr.debug-leftover',
         "+      console.log('[updater] installUpdate requested')", "+      logger.info('Update install requested')", False,
         'structured production logger instead of temporary console trace')
mutation(64, 'src/main/pty/TmuxManager.ts', 'execFile(this.tmuxPath!', 'sec.command-injection',
         '+      execFile(this.tmuxPath!, fullArgs, { env, timeout: 10000 }, (err, stdout) => {',
         '+      exec(`tmux ${fullArgs.join(" ")}`, { env, timeout: 10000 }, (err, stdout) => {', True,
         'replace safe argv invocation with shell command interpolation')

# PR-level rows deliberately select source and test files together, preserving
# the real PR title/description; narrow file sample is enough for tests.missing.
for n, choose in [(27, ('src/main/index.ts',)), (342, ('src/renderer/src/components/shared/Markdown.svelte',)),
                  (283, ('package.json',)), (14, ('e2e/app-launch.spec.ts', 'src/main/index.ts'))]:
    selected = [f for f in FILES[str(n)] if f['path'] in choose]
    if n == 14 and len(selected) != 2:
        selected = [next(f for f in FILES[str(n)] if f['path'].endswith('.spec.ts')),
                    next(f for f in FILES[str(n)] if f['path'].startswith('src/'))]
    assert len(selected) == len(choose)
    rows.append(dict(id=f'pr{n}-tests-missing', source=f'https://github.com/itsoltech/canopy-desktop/pull/{n}',
                     provenance='public-PR-selected-files',
                     label_note=('dependency package manifest only' if n == 283 else 'application behavior changed' if n != 14 else 'test file changed alongside application source'),
                     pr={'title': PRS[n]['title'], 'body': PRS[n].get('body') or ''}, files=selected,
                     labels={'tests.missing': {'violates': n not in (14, 283)}}))
save('baseline.jsonl', rows)
