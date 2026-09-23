/**
 * Run a config's code-checked rules (pattern on added lines) over saved PR diffs, without Jev.
 * Shows how often each rule fires and sample lines, to review a regex before enabling it.
 *
 *   npm run scan-patterns -- --files /tmp/canopy-data/pr_files.json --config examples/canopy/jev-review.yml [--rule id] [--samples 8]
 *
 * --files is a JSON object {prNumber: [{path, status, additions, deletions, patch}]}, as written
 * by eval/canopy/fetch_data.py.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config/load.js";
import { activeRules } from "../src/jev/questions.js";
import { linePatternFindings } from "../src/policy/findings.js";
import { buildSubjects } from "../src/run.js";
import type { ChangedFile } from "../src/types.js";
import { arg, localGitHub } from "./lib.js";

const prFiles = JSON.parse(readFileSync(arg("files") ?? "/tmp/canopy-data/pr_files.json", "utf8")) as Record<string, ChangedFile[]>;
const local = localGitHub([], arg("config"));
const { config } = await loadConfig(".github/jev-review.yml", (path) => local.readFile(path, "local"));
const only = arg("rule");
const rules = config.rules.filter((r) => r.type === "pattern" && r.field === "added_lines" && (!only || r.id === only));
const samples = Number(arg("samples") ?? 6);

const hits = new Map<string, { prs: Set<string>; lines: string[] }>(rules.map((r) => [r.id, { prs: new Set(), lines: [] }]));
let hunks = 0;
for (const [pr, files] of Object.entries(prFiles)) {
  // No file or hunk limits: every added line of every PR is checked.
  const cfg = { ...config, files: { ...config.files, max_file_changes: Number.MAX_SAFE_INTEGER }, budget: { ...config.budget, max_hunks: Number.MAX_SAFE_INTEGER } };
  const { subjects } = buildSubjects(files, cfg);
  hunks += subjects.filter((s) => s.kind === "hunk").length;
  // Apply `when` as a review would; title conditions are unknown here, so pass none.
  const active = activeRules(rules, { title: "", body: "" }, files);
  for (const f of linePatternFindings(active, subjects)) {
    const h = hits.get(f.rule.id)!;
    h.prs.add(pr);
    h.lines.push(`#${pr} ${f.location!.path}:${f.location!.line}  ${f.location!.text.trim().slice(0, 110)}`);
  }
}

console.log(`${Object.keys(prFiles).length} PRs, ${hunks} hunks\n`);
for (const rule of rules) {
  const h = hits.get(rule.id)!;
  console.log(`${rule.id}: ${h.lines.length} hunks in ${h.prs.size} PRs`);
  const step = Math.max(1, Math.floor(h.lines.length / samples));
  for (let i = 0; i < h.lines.length && i / step < samples; i += step) console.log(`   ${h.lines[i]}`);
}
