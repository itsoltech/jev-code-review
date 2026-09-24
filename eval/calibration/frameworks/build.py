"""Build manually labeled framework calibration rows from public canopy diff files.

The five held-out PRs were inspected and labeled before any framework API result.
Training examples below are selected/edited separately; never include the held-out PRs.
"""
import json
from pathlib import Path

ROOT = Path(__file__).parent
SOURCE = Path('/tmp/canopy-data/pr_files.json')
RESERVED = {284, 285, 286, 287, 289}


def emit(name, rows):
    path = ROOT / name
    path.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
    print(path, len(rows), 'rows')


def holdout():
    files = json.loads(SOURCE.read_text())
    rows = []
    for number in sorted(RESERVED):
        for index, file in enumerate(files[str(number)]):
            path = file['path']
            applicable = []
            if path.startswith('src/main/') and path.endswith('.ts'):
                applicable = ['errors.try-catch-outside-boundaries', 'errors.throw-new-error',
                              'electron.ipc-send-on', 'electron.ipc-channel-name',
                              'electron.sync-fs-main', 'electron.ipc-unvalidated-input']
            elif path.startswith('src/renderer/') and path.endswith(('.ts', '.svelte')):
                applicable = ['electron.renderer-node-import', 'electron.os-specific-label',
                              'electron.ipc-send-on', 'electron.shortcut-label-os']
                if path.endswith(('.svelte', '.svelte.ts')):
                    applicable += ['svelte.effect-without-cleanup', 'svelte.effect-as-derived']
                if path.endswith('.svelte'):
                    applicable += ['svelte.legacy-export-let']
            elif path.startswith('src/preload/'):
                applicable = ['electron.ipc-send-on', 'electron.preload-generic-invoke']
            if not applicable:
                continue
            # Human label: PR 285 is presentation of existing typed-error values,
            # 286 is Windows path equivalence, 287 and 289 are icon import migrations.
            # None adds an effect, IPC handler, forbidden Node import, legacy prop,
            # OS-exclusive label, shortcut, sync fs call, throw, or try/catch block.
            rows.append(dict(id=f'holdout-pr{number}-{index}', source=f'https://github.com/itsoltech/canopy-desktop/pull/{number}/files',
                             path=path, patch=file['patch'],
                             labels={rule: {'violates': False} for rule in applicable},
                             note='Independent inspection before policy tuning; entire original file diff, not mutation'))
    emit('holdout.jsonl', rows)

def train():
    source = [json.loads(line) for line in Path('eval/datasets/canopy-code.jsonl').read_text().splitlines()]
    files = json.loads(SOURCE.read_text())
    rows = []
    for rule in ('errors.try-catch-outside-boundaries', 'electron.ipc-unvalidated-input',
                 'svelte.effect-without-cleanup', 'svelte.effect-as-derived'):
        for truth in (True, False):
            candidates = [r for r in source if rule in r['labels'] and r['labels'][rule]['violates'] == truth
                          and not any(f'pr{n}-' in r['id'] for n in RESERVED)]
            # Hand-labeled source labels already fix ground truth; favor concise patches
            # and multiple PRs rather than copies of one mutation.
            candidates.sort(key=lambda r: len(r['patch']))
            selected = []
            seen = set()
            for row in candidates:
                pr = row['id'].split('-')
                pr_id = next((part for part in pr if part.startswith('pr')), row['id'])
                if pr_id in seen or len(row['patch']) > 3200:
                    continue
                seen.add(pr_id)
                selected.append(row)
                if len(selected) == 15:
                    break
            for row in selected:
                rows.append({**row, 'id': 'train-' + row['id'], 'labels': {rule: row['labels'][rule]},
                             'note': row.get('note', 'Existing labeled canopy-code row; inherit synthetic marker when present')})

    def hunk(pr, path, needle, rule, violates, *, mutation=None, case=None):
        file = next(f for f in files[str(pr)] if f['path'] == path)
        patch = file['patch']
        hunks = [part for part in __import__('re').split(r'(?=^@@ )', patch, flags=__import__('re').M) if part.startswith('@@ ')]
        matching = [part for part in hunks if any(line.startswith('+') and needle in line for line in part.splitlines())]
        if not matching:
            raise ValueError((pr, path, needle))
        original = matching[0]
        if mutation:
            before, after = mutation
            if before not in original:
                raise ValueError(('mutation anchor missing', pr, before))
            original = original.replace(before, after, 1)
        identifier = case or (needle.replace(' ', '-')[:25])
        rows.append(dict(id=f'train-pr{pr}-{rule}-{identifier}', source=f'https://github.com/itsoltech/canopy-desktop/pull/{pr}/files',
                         path=path, patch=original, labels={rule: {'violates': violates}},
                         note='Real source diff' if not mutation else f'Mutation of real PR {pr} diff; {mutation[0]!r} -> {mutation[1]!r}'))

    # Deterministic rules: actual violating main-process code and real clean
    # diffs, plus explicit one-line mutations where history has no violation.
    hunk(3, 'src/main/ipc/handlers.ts', "throw new Error('No window", 'errors.throw-new-error', True)
    hunk(3, 'src/main/ipc/handlers.ts', "ipcMain.handle('pty:write'", 'errors.throw-new-error', False)
    hunk(13, 'src/preload/index.ts', 'ipcRenderer.send', 'electron.ipc-send-on', True)
    hunk(3, 'src/main/ipc/handlers.ts', "ipcMain.handle('pty:write'", 'electron.ipc-send-on', False)
    hunk(3, 'src/main/browser/BrowserManager.ts', 'writeFileSync(filePath', 'electron.sync-fs-main', True)
    hunk(3, 'src/main/ipc/handlers.ts', "ipcMain.handle('pty:write'", 'electron.sync-fs-main', False)
    hunk(98, 'src/renderer/src/lib/platform.ts', 'Reveal in Finder', 'electron.os-specific-label', False)
    hunk(98, 'src/renderer/src/lib/platform.ts', 'Open in File Manager', 'electron.os-specific-label', True,
         mutation=(".otherwise(() => 'Open in File Manager')", ".otherwise(() => 'Reveal in Finder')"),
         case='linux-fallback-finder-mutation')
    hunk(1, 'src/main/index.ts', "ipcMain.handle('app:getAboutInfo'", 'electron.ipc-channel-name', False)
    hunk(1, 'src/main/index.ts', "ipcMain.handle('app:getAboutInfo'", 'electron.ipc-channel-name', True,
         mutation=("ipcMain.handle('app:getAboutInfo'", "ipcMain.handle('getAboutInfo'"), case='invalid-channel-mutation')
    hunk(1, 'src/preload/index.ts', "ipcRenderer.invoke('app:getAboutInfo'", 'electron.preload-generic-invoke', False)
    hunk(1, 'src/preload/index.ts', "ipcRenderer.invoke('app:getAboutInfo'", 'electron.preload-generic-invoke', True,
         mutation=("getAboutInfo: () => ipcRenderer.invoke('app:getAboutInfo'", "getAboutInfo: (channel: string) => ipcRenderer.invoke(channel"),
         case='generic-channel-mutation')
    hunk(8, 'src/renderer/src/components/TitlebarMenu.svelte', 'Ctrl+Shift+N', 'electron.shortcut-label-os', False)
    hunk(8, 'src/renderer/src/components/TitlebarMenu.svelte', 'Ctrl+Shift+N', 'electron.shortcut-label-os', True,
         case='shared-menu-mutation')
    # The shared-menu mutation moves exactly the displayed label out of the
    # explicitly platform-exclusive TitlebarMenu into an ordinary renderer view.
    rows[-1]['path'] = 'src/renderer/src/components/browser/BrowserPane.svelte'
    rows[-1]['note'] = 'Mutation of PR 8: same platform-exclusive titlebar label in shared browser view.'
    hunk(1, 'src/main/index.ts', "import { readFileSync } from 'fs'", 'electron.renderer-node-import', False)
    hunk(1, 'src/main/index.ts', "import { readFileSync } from 'fs'", 'electron.renderer-node-import', True,
         case='main-import-moved-to-renderer')
    rows[-1]['path'] = 'src/renderer/src/lib/platform.ts'
    rows[-1]['note'] = 'Mutation of PR 1: main-only fs import moved into renderer module.'
    hunk(1, 'src/preload/index.ts', "ipcRenderer.invoke('app:getAboutInfo'", 'electron.renderer-node-import', False)
    # New Svelte 5 component uses $props; mutation replaces the actual declaration.
    hunk(3, 'src/renderer/src/components/browser/BrowserPane.svelte', '} = $props()', 'svelte.legacy-export-let', False)
    hunk(3, 'src/renderer/src/components/browser/BrowserPane.svelte', '} = $props()', 'svelte.legacy-export-let', True,
         mutation=("+  let {\n+    browserId,\n+    active,\n+    onTitleChange,\n+  }: {\n+    browserId: string\n+    active: boolean\n+    onTitleChange: (title: string) => void\n+  } = $props()",
                   "+  export let browserId: string\n+  export let active: boolean\n+  export let onTitleChange: (title: string) => void"),
         case='legacy-prop-mutation')
    hunk(4, 'src/main/git/GitRepository.ts', 'throw new Error(`Invalid git ref', 'errors.throw-new-error', True)
    hunk(18, 'src/main/ipc/handlers.ts', "throw new Error('Access denied", 'errors.throw-new-error', True)
    hunk(13, 'src/main/index.ts', "ipcMain.on('notch:setEnabled'", 'electron.ipc-send-on', True)
    hunk(52, 'src/preload/index.ts', "ipcRenderer.send('worktree:abortSetup'", 'electron.ipc-send-on', True)
    hunk(55, 'src/main/browser/BrowserManager.ts', 'writeFileSync(filePath', 'electron.sync-fs-main', True)
    hunk(4, 'src/main/index.ts', 'realpathSync(resolve(path))', 'electron.sync-fs-main', True)
    hunk(85, 'src/renderer/src/components/preferences/GeneralPrefs.svelte', 'Ctrl+T', 'electron.shortcut-label-os', False)
    hunk(183, 'src/renderer/src/components/editor/EditorPane.svelte', 'Cmd/Ctrl+S', 'electron.shortcut-label-os', False)
    hunk(324, 'src/renderer/src/components/taskTracker/TaskPanel.svelte', 'Send to the agent (Ctrl+Enter)', 'electron.shortcut-label-os', True)
    hunk(98, 'src/renderer/src/lib/platform.ts', 'Show in Explorer', 'electron.os-specific-label', False)
    hunk(98, 'src/renderer/src/lib/platform.ts', 'Open in File Manager', 'electron.os-specific-label', True,
         mutation=(".otherwise(() => 'Open in File Manager')", ".otherwise(() => 'Show in Explorer')"),
         case='linux-fallback-explorer-mutation')
    hunk(98, 'src/renderer/src/lib/platform.ts', 'Open in File Manager', 'electron.os-specific-label', True,
         mutation=(".otherwise(() => 'Open in File Manager')",
                   ".otherwise(() => 'Reveal in Finder') // platform-neutral fallback"),
         case='unguarded-label-with-platform-comment-mutation')
    for pr, path, channel in [(3, 'src/main/ipc/handlers.ts', 'pty:write'),
                              (13, 'src/main/index.ts', 'notch:setEnabled')]:
        hunk(pr, path, f"ipcMain.handle('{channel}'" if pr == 3 else f"ipcMain.on('{channel}'",
             'electron.ipc-channel-name', False, case=f'valid-pr{pr}-channel')
        hunk(pr, path, f"ipcMain.handle('{channel}'" if pr == 3 else f"ipcMain.on('{channel}'",
             'electron.ipc-channel-name', True, mutation=(f"'{channel}'", f"'{channel.replace(':', '-')}'"),
             case=f'invalid-pr{pr}-channel-mutation')
    for pr, path, channel in [(3, 'src/preload/index.ts', 'browser:create'),
                              (18, 'src/preload/index.ts', 'fs:readDir')]:
        hunk(pr, path, f"ipcRenderer.invoke('{channel}'", 'electron.preload-generic-invoke', False)
        original = {
            3: "createBrowser: () => ipcRenderer.invoke('browser:create'",
            18: "readDir: (dirPath: string) => ipcRenderer.invoke('fs:readDir'",
        }[pr]
        changed = {
            3: "createBrowser: (channel: string) => ipcRenderer.invoke(channel",
            18: "readDir: (channel: string, dirPath: string) => ipcRenderer.invoke(channel",
        }[pr]
        hunk(pr, path, f"ipcRenderer.invoke('{channel}'", 'electron.preload-generic-invoke', True,
             mutation=(original, changed), case=f'generic-pr{pr}-mutation')
    hunk(3, 'src/main/browser/BrowserManager.ts', "from 'electron'", 'electron.renderer-node-import', True,
         case='electron-import-in-renderer-mutation')
    rows[-1]['path'] = 'src/renderer/src/lib/platform.ts'
    rows[-1]['note'] = 'Mutation of PR 3: Electron import moved from main into renderer.'
    hunk(4, 'src/main/index.ts', "from 'path'", 'electron.renderer-node-import', True,
         case='path-import-in-renderer-mutation')
    rows[-1]['path'] = 'src/renderer/src/lib/platform.ts'
    rows[-1]['note'] = 'Mutation of PR 4: Node path import moved from main into renderer.'
    hunk(18, 'src/renderer/src/components/editor/EditorPane.svelte', '} = $props()', 'svelte.legacy-export-let', False)
    hunk(18, 'src/renderer/src/components/editor/EditorPane.svelte', '} = $props()', 'svelte.legacy-export-let', True,
         mutation=("+  let {\n+    filePath,\n+    active,\n+  }: {\n+    filePath: string\n+    active: boolean\n+  } = $props()",
                   "+  export let filePath: string\n+  export let active: boolean"),
         case='legacy-editor-prop-mutation')

    # Added components: the patch is the whole new file, so its exact added-line
    # count is the head file length. Unchanged over-limit files cannot be labeled
    # without a historical head snapshot and are not represented by a fabricated text.
    for pr, path, violates in [
        (3, 'src/renderer/src/components/browser/BrowserPane.svelte', True),
        (3, 'src/renderer/src/components/browser/BrowserToolbar.svelte', True),
        (13, 'src/renderer/src/components/notch/NotchOverlay.svelte', False),
        (18, 'src/renderer/src/components/editor/EditorPane.svelte', False),
    ]:
        file = next(f for f in files[str(pr)] if f['path'] == path)
        assert file['status'] == 'added' and file['deletions'] == 0
        text = '\n'.join(line[1:] for line in file['patch'].splitlines() if line.startswith('+') and not line.startswith('+++')) + '\n'
        rows.append(dict(id=f'train-pr{pr}-size-{path.rsplit("/", 1)[-1]}',
                         source=f'https://github.com/itsoltech/canopy-desktop/pull/{pr}/files',
                         path=path, patch=file['patch'], file_text=text,
                         labels={'svelte.component-size': {'violates': violates}},
                         note='Original complete added component; head text reconstructed from added lines'))
    if any(any(f'pr{n}-' in row['id'] for n in RESERVED) for row in rows):
        raise ValueError('Reserved PR leaked into tuning')
    assert len({row['id'] for row in rows}) == len(rows)
    emit('train.jsonl', rows)




if __name__ == '__main__':
    holdout()
    train()
