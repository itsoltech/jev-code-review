import { describe, expect, it } from "vitest";
import { parsePatch } from "../../src/diff/parse.js";
import { splitHunk } from "../../src/diff/split.js";

describe("parsePatch", () => {
  it("maps added and context lines to RIGHT line numbers", () => {
    const patch = [
      "@@ -10,4 +10,5 @@ function a() {",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 3;",
      "+const z = 4;",
      " return x;",
    ].join("\n");
    const [hunk] = parsePatch("src/a.ts", patch);
    expect(hunk!.lines.map((l) => [l.id, l.kind, l.rightLine, l.leftLine])).toEqual([
      ["L001", "context", 10, 10],
      ["L002", "del", undefined, 11],
      ["L003", "add", 11, undefined],
      ["L004", "add", 12, undefined],
      ["L005", "context", 13, 12],
    ]);
  });

  it("parses several hunks and skips no-newline markers", () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      "-a",
      "+b",
      "\\ No newline at end of file",
      "@@ -20 +20,2 @@",
      " c",
      "+d",
      "",
    ].join("\n");
    const hunks = parsePatch("f", patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.lines).toHaveLength(2);
    expect(hunks[1]!.lines.map((l) => l.rightLine)).toEqual([20, 21]);
  });

  it("handles CRLF and new files", () => {
    const patch = "@@ -0,0 +1,2 @@\r\n+one\r\n+two\r\n";
    const [hunk] = parsePatch("new.txt", patch);
    expect(hunk!.lines.map((l) => [l.text, l.rightLine])).toEqual([
      ["one", 1],
      ["two", 2],
    ]);
  });

  it("skips git file headers in full diffs", () => {
    const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    const [hunk] = parsePatch("x", patch);
    expect(hunk!.lines.map((l) => l.kind)).toEqual(["del", "add"]);
  });

  it("returns nothing for an empty patch", () => {
    expect(parsePatch("x", "")).toEqual([]);
  });
});

describe("splitHunk", () => {
  it("splits long hunks into overlapping windows with fresh ids", () => {
    const body = Array.from({ length: 10 }, (_, i) => `+line ${i}`).join("\n");
    const [hunk] = parsePatch("f", `@@ -0,0 +1,10 @@\n${body}`);
    const parts = splitHunk(hunk!, 4, 1);
    expect(parts.map((p) => p.lines.map((l) => l.rightLine))).toEqual([
      [1, 2, 3, 4],
      [4, 5, 6, 7],
      [7, 8, 9, 10],
    ]);
    expect(parts[1]!.lines[0]!.id).toBe("L001");
  });

  it("keeps short hunks unchanged", () => {
    const [hunk] = parsePatch("f", "@@ -1 +1 @@\n+a");
    expect(splitHunk(hunk!, 10)).toEqual([hunk]);
  });
});

describe("filesFromGitDiff (scripts)", () => {
  it("splits a git diff into GitHub-like files", async () => {
    const { filesFromGitDiff } = await import("../../scripts/lib.js");
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      " a",
      "+b",
      "diff --git a/img.png b/img.png",
      "new file mode 100644",
      "Binary files /dev/null and b/img.png differ",
      "",
    ].join("\n");
    const files = filesFromGitDiff(diff);
    expect(files.map((f) => [f.path, f.status, f.additions, Boolean(f.patch)])).toEqual([
      ["src/a.ts", "modified", 1, true],
      ["img.png", "added", 0, false],
    ]);
  });
});
