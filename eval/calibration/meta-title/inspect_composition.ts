import { writeFileSync } from "node:fs";
import { loadConfig } from "../../../src/config/load.js";
import { localGitHub } from "../../../scripts/lib.js";
const configPath = "eval/calibration/meta-title/recommended.yml";
const { config, sources, warnings } = await loadConfig(".github/jev-review.yml", (path) => localGitHub([], configPath).readFile(path, "local"));
const result = { configPath, sources, warnings, rules: config.rules.map((rule) => ({ id: rule.id, type: rule.type, severity: rule.severity, enabled: rule.enabled })), dimensions: config.dimensions.map(({ id, scope, enabled, weight }) => ({ id, scope, enabled, weight })), policy: config.policy };
writeFileSync("eval/calibration/meta-title/recommended-composition.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ sources, activeRules: result.rules.filter((x) => x.enabled).map((x) => x.id), dimensions: result.dimensions, policy: result.policy }, null, 2));
