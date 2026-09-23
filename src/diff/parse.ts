export type LineKind = "add" | "context" | "del";

export interface DiffLine {
  /** Stable id inside its hunk, e.g. "L001". Jev points at lines through these ids. */
  id: string;
  kind: LineKind;
  text: string;
  /** Line number in the new file (RIGHT side); set for added and context lines. */
  rightLine?: number;
  /** Line number in the old file (LEFT side); set for deleted and context lines. */
  leftLine?: number;
}

export interface Hunk {
  path: string;
  header: string;
  lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function lineId(i: number): string {
  return `L${String(i + 1).padStart(3, "0")}`;
}

export function assignIds(lines: Omit<DiffLine, "id">[]): DiffLine[] {
  return lines.map((line, i) => ({ ...line, id: lineId(i) }));
}

/**
 * Parse a GitHub `files[].patch` (hunks only, no file headers) into hunks.
 * Full `git diff` output is accepted too: file headers before the first hunk are skipped.
 */
export function parsePatch(path: string, patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: { header: string; lines: Omit<DiffLine, "id">[] } | undefined;
  let left = 0;
  let right = 0;

  const flush = () => {
    if (current && current.lines.length > 0) {
      hunks.push({ path, header: current.header, lines: assignIds(current.lines) });
    }
    current = undefined;
  };

  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop(); // trailing newline, not an empty context line

  for (const raw of rows) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const header = HUNK_HEADER.exec(line);
    if (header) {
      flush();
      left = Number(header[1]);
      right = Number(header[2]);
      current = { header: line, lines: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") {
      current.lines.push({ kind: "add", text, rightLine: right++ });
    } else if (marker === "-") {
      current.lines.push({ kind: "del", text, leftLine: left++ });
    } else if (marker === " " || line === "") {
      // Some tools strip the leading space from blank context lines.
      current.lines.push({ kind: "context", text, leftLine: left++, rightLine: right++ });
    }
  }
  flush();
  return hunks;
}
