import { assignIds, type Hunk } from "./parse.js";

/**
 * Split hunks longer than `maxLines` into overlapping windows.
 * Smaller windows keep state focused for Jev and keep line-id choices small.
 */
export function splitHunk(hunk: Hunk, maxLines: number, overlap = 3): Hunk[] {
  if (hunk.lines.length <= maxLines) return [hunk];
  const step = Math.max(1, maxLines - overlap);
  const parts: Hunk[] = [];
  for (let start = 0; start < hunk.lines.length; start += step) {
    const slice = hunk.lines.slice(start, start + maxLines).map(({ id: _id, ...rest }) => rest);
    parts.push({ path: hunk.path, header: hunk.header, lines: assignIds(slice) });
    if (start + maxLines >= hunk.lines.length) break;
  }
  return parts;
}

export function addedLines(hunk: Hunk) {
  return hunk.lines.filter((l) => l.kind === "add");
}
