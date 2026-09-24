"""Build code-slop calibration inputs; PR 284/285/286/287/289 are holdout-only.

Frozen holdout labels were assigned by reading the added code before any Jev run on
these PRs. Some rule/file labels are unknown where a required contract is absent;
there are no labelled violations. This is NOT proof of recall, nor a fully blind
prospective holdout (PR titles occur elsewhere). Do not change holdout labels to
match model answers.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
SOURCE = Path('/tmp/canopy-data')
HOLDOUT = {284, 285, 286, 287, 289}
EXTS = ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.vue')


def read_jsonl(path):
    return [json.loads(s) for s in path.read_text().splitlines() if s.strip()]


def save(name, rows):
    (OUT / name).write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows))


if __name__ == '__main__':
    # Hand-labelled real additions. Each excerpt is copied verbatim from a
    # non-holdout PR; excerpting is disclosed (not a complete repository view).
    # Only local behavior demonstrable from the excerpt is labelled clean.
    real_cases = [
        (9, 'src/renderer/src/lib/stores/tabs.svelte.ts', 'pane.inspectorOpen = pane.inspectorOpen === false ? true : false',
         {'slop.boolean-ternary': True, 'slop.copied-branch': False}, 9, 6,
         'Boolean equality already yields exactly the chosen true/false; two branches differ.'),
        (3, 'src/preload/index.ts', "onBrowserUrlChanged: (callback:", {'slop.wrapper-chain': False, 'slop.ignored-parameter': False}, 2, 12,
         'Adapter removes the Electron IPC event, forwards payload and returns listener disposer.'),
        (3, 'src/main/browser/BrowserManager.ts', '// Favicon fetch failed, ignore',
         {'slop.failure-as-success': False, 'slop.useless-catch': False, 'slop.lost-error-cause': False,
          'slop.unawaited-async-work': False, 'slop.domain-error-in-generic-helper': False}, 14, 4,
         'Optional favicon retrieval explicitly tolerates failure, catch does not rethrow or wrap, Promise rejection is handled.'),
        (4, 'src/main/claude/ClaudeHookServer.ts', "typeof provided !== 'string'",
         {'slop.revalidated-invariant': False, 'slop.api-mismatch': False}, 4, 9,
         'Untrusted HTTP header is checked at its input boundary; no dependency call is claimed invalid.'),
        (13, 'src/preload/notch.ts', '@ts-ignore -- fallback for non-isolated context',
         {'slop.unchecked-type-cast': False}, 8, 4,
         'Suppression is explicitly scoped to Electron contextBridge fallback, not external-data validation.'),
        (91, 'src/main/errors.ts', 'export function fromExternalCall<T, E>',
         {'slop.unverified-generic': False, 'slop.speculative-extension': False}, 2, 7,
         'T is inferred from the input Promise<T>; no factory, registry or strategy is introduced.'),
        (14, 'e2e/app-launch.spec.ts', "test('app launches and shows main window'",
         {'slop.test-without-real-assertion': False}, 1, 9,
         'Smoke test checks actual Electron windows and page title, not an unrelated constant.'),
        (18, 'src/renderer/src/components/sidebar/FileTreeSection.svelte',
         'TODO: add virtualization for large directory trees',
         {'slop.placeholder-success': False}, 2, 12,
         'Implemented file tree renders entries; TODO describes future virtualization only.'),
        (96, 'src/renderer/src/components/diff/ChangesPanel.svelte',
         'totalAdditions = $derived(allFiles.reduce',
         {'slop.empty-pipeline-step': False, 'slop.duplicated-business-rule': False}, 4, 7,
         'Reduce sums per-file additions; no shared copied domain rule is established.'),
        (52, 'src/main/worktree/WorktreeSetupRunner.ts', "shellPath = isWin ?",
         {'slop.falsy-fallback': False, 'slop.copied-branch': False}, 2, 7,
         'An empty SHELL means use the next available shell; Windows uses a different shell.'),
        (3, 'src/renderer/src/components/browser/BrowserPane.svelte',
         'toolbarComponent?.focusUrlBar()',
         {'slop.optional-chaining-skips-required-step': False}, 4, 5,
         'Toolbar ref may be unavailable before mount; focus command is optional.'),
        (3, 'src/renderer/src/components/browser/BrowserError.svelte',
         'onclick={onRetry}',
         {'slop.ignored-parameter': False, 'slop.unsafe-retry': False}, 9, 3,
         'Actual retry callback is wired to user click, no automatic unbounded retry.'),
        (3, 'src/main/browser/BrowserManager.ts',
         "type: input.type === 'keyUp' ? 'keyUp' : 'keyDown'",
         {'slop.nested-ternary': False, 'slop.copied-branch': False}, 3, 6,
         'Single typed case switch returns different correct event kinds.'),
        (1, 'src/preload/index.ts', '// About',
         {'slop.useless-comment': False}, 1, 7,
         'Section heading groups related preload APIs; not a misleading description of one statement.'),
        (18, 'src/renderer/src/components/editor/EditorPane.svelte',
         'async function loadFile(): Promise<void>',
         {'slop.unawaited-async-work': False}, 1, 40,
         'Reactive invocation does not require a returned Promise; loadFile handles rejected read inside try/catch.'),
        (91, 'src/main/git/GitRepository.ts',
         'function gitCall<T>(command: string, promise: Promise<T>)',
         {'slop.domain-error-in-generic-helper': False}, 5, 4,
         'Helper is scoped to git operations and carries the git command in error.'),
    ]
    fixtures = read_jsonl(ROOT / 'eval/datasets/code-slop-fixtures.jsonl')
    mutations = read_jsonl(ROOT / 'eval/datasets/code-slop-mutations.jsonl')
    for row in fixtures:
        row['calibration_origin'] = 'contract-given rule-pack fixture, NOT unprompted real PR'
    for row in mutations:
        row['calibration_origin'] = 'real-code mutation or original control, NOT unprompted real PR violation'
    files = json.loads((SOURCE / 'pr_files.json').read_text())
    prs = {p['number']: p for p in json.loads((SOURCE / 'prs_full.json').read_text())}
    natural = []
    notes = {}
    for index, (pr, path, needle, labels, before, after, reason) in enumerate(real_cases):
        assert pr not in HOLDOUT
        source = next(f for f in files[str(pr)] if f['path'] == path)
        lines = source['patch'].splitlines()
        hits = [i for i, line in enumerate(lines) if line.startswith('+') and needle in line]
        assert hits, (pr, path, needle)
        focus = hits[0]
        excerpt = [s[1:] for s in lines[max(0, focus-before):focus+after+1] if s.startswith('+') and not s.startswith('+++')]
        assert any(needle in s for s in excerpt)
        natural.append({
            'id': f'natural-pr{pr}-{index}',
            'source': f'https://github.com/itsoltech/canopy-desktop/pull/{pr}/files',
            'calibration_origin': 'unprompted real PR added-line excerpt, NOT complete file or new mutation',
            'path': path, 'patch': f'@@ -0,0 +1,{len(excerpt)} @@\n' + '\n'.join('+' + s for s in excerpt),
            'labels': {rule: {'violates': truth, 'expected': 'present' if truth else 'absent'} for rule, truth in labels.items()},
        })
        notes[natural[-1]['id']] = {'pr': pr, 'pr_title': prs[pr]['title'], 'path': path, 'reason': reason, 'added_line_needle': needle}
    save('natural.jsonl', natural)
    (OUT / 'natural-label-notes.json').write_text(json.dumps(notes, indent=2) + '\n')
    ids = [next(iter(row['labels'])) for row in fixtures]
    rule_ids = sorted(set(ids))
    assert len(rule_ids) == 24 and len(fixtures) == 62 and len(mutations) == 80
    holdout = []
    for pr_number in sorted(HOLDOUT):
        for index, file in enumerate(files[str(pr_number)]):
            if not file['path'].endswith(EXTS) or not file.get('patch'):
                continue
            holdout.append({
                'id': f'holdout-pr{pr_number}-file{index}',
                'source': f'https://github.com/itsoltech/canopy-desktop/pull/{pr_number}/files',
                'path': file['path'], 'patch': file['patch'],
                'calibration_origin': 'reserved source PR; all changed source files hand-read before holdout model run',
                'labels': {rule: {'violates': False, 'expected': 'absent'} for rule in rule_ids},
            })
            if pr_number in (287, 289) and "from '@lucide/svelte'" in file['patch']:
                holdout[-1]['labels']['slop.api-mismatch'] = {
                    'violates': False, 'expected': 'insufficient_context',
                }
            if pr_number == 286 and 'as Task' in file['patch']:
                holdout[-1]['labels']['slop.unchecked-type-cast'] = {
                    'violates': False, 'expected': 'insufficient_context',
                }
    assert len(holdout) == 25, len(holdout)
    save('holdout.jsonl', holdout)
    # Never append holdout rows to tuning.jsonl.
    save('tuning.jsonl', fixtures + mutations + natural)
    print(f'Tuning: {len(fixtures)} contract-given fixtures + {len(mutations)} real-code mutations/controls + {len(natural)} unprompted PR excerpts; holdout: {len(holdout)} code files')
