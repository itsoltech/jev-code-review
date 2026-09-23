import type { ChangedFile } from "../types.js";

/** Split `git diff` output into per-file patches shaped like GitHub's pulls.listFiles. */
export function filesFromGitDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const section of diff.split(/^diff --git /m).slice(1)) {
    const header = section.slice(0, section.indexOf("\n"));
    const path = /\sb\/(.+)$/.exec(header)?.[1] ?? header;
    const start = section.search(/^@@ /m);
    const patch = start >= 0 ? section.slice(start).replace(/\n$/, "") : undefined;
    const lines = patch?.split("\n") ?? [];
    files.push({
      path,
      status: /^deleted file/m.test(section) ? "removed" : /^new file/m.test(section) ? "added" : /^rename from/m.test(section) ? "renamed" : "modified",
      additions: lines.filter((l) => l.startsWith("+")).length,
      deletions: lines.filter((l) => l.startsWith("-")).length,
      ...(patch ? { patch } : {}),
    });
  }
  return files;
}
