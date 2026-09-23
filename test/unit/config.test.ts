import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type ReadFile } from "../../src/config/load.js";
import { PRESETS } from "../../src/presets/index.js";

const repo = (files: Record<string, string>): ReadFile => async (p) => files[p];

describe("loadConfig", () => {
  it("uses the recommended preset when the file is missing", async () => {
    const { config, warnings, sources } = await loadConfig(".github/jev-review.yml", repo({}));
    expect(warnings[0]).toMatch(/No config/);
    expect(sources[0]).toBe("jev:base");
    const ids = config.rules.map((r) => r.id);
    expect(ids).toContain("meta.injection");
    expect(ids).toContain("sec.sql-concat");
    expect(ids).toContain("tests.missing");
    expect(config.model).toBe("jev-latest");
    expect(config.policy.approve.enabled).toBe(false);
  });

  it("every preset parses and validates on its own", async () => {
    for (const name of Object.keys(PRESETS)) {
      const cfg = `extends: ["jev:${name}"]\n`;
      await expect(loadConfig("c.yml", repo({ "c.yml": cfg }))).resolves.toBeDefined();
    }
  });

  it("overrides and disables inherited rules by id", async () => {
    const cfg = `
extends: ["jev:security", ./team.yml]
model: jev-1.13.0
budget: { concurrency: 2 }
rules:
  - id: sec.sql-concat
    threshold: 0.9
  - id: sec.unsafe-html
    enabled: false
  - id: custom.no-moment
    type: noul
    severity: minor
    paths: ["src/**/*.ts"]
    instructions: Does an added line import the moment library?
`;
    const team = `rules:\n  - id: sec.sql-concat\n    severity: major\n`;
    const { config, sources } = await loadConfig("c.yml", repo({ "c.yml": cfg, "team.yml": team }));
    const byId = new Map(config.rules.map((r) => [r.id, r]));
    const sql = byId.get("sec.sql-concat")!;
    expect(sql.type === "noul" && sql.threshold).toBe(0.9);
    expect(sql.severity).toBe("major");
    expect(byId.has("sec.unsafe-html")).toBe(false);
    expect(byId.get("custom.no-moment")?.scope).toBe("hunk");
    expect(config.model).toBe("jev-1.13.0");
    expect(config.budget.concurrency).toBe(2);
    expect(config.budget.max_hunks).toBe(150);
    expect(sources).toEqual(["jev:base", "jev:security", "./team.yml", "c.yml"]);
  });

  it("reports invalid rules with their id", async () => {
    const cfg = `rules:\n  - id: bad\n    type: score\n    instructions: x\n    criteria: [only-one]\n`;
    await expect(loadConfig("c.yml", repo({ "c.yml": cfg }))).rejects.toThrow(/rule bad/);
  });

  it("rejects finding_labels that are not options", async () => {
    const cfg = `rules:\n  - id: c\n    type: choice\n    instructions: x\n    criteria: { a: null, b: null }\n    finding_labels: { z: major }\n`;
    await expect(loadConfig("c.yml", repo({ "c.yml": cfg }))).rejects.toThrow(/finding_labels not in criteria: z/);
  });

  it("rejects cycles, remote and escaping extends", async () => {
    await expect(loadConfig("a.yml", repo({ "a.yml": "extends: [b.yml]", "b.yml": "extends: [a.yml]" }))).rejects.toThrow(/cycle/);
    await expect(loadConfig("a.yml", repo({ "a.yml": "extends: [https://x.y/c.yml]" }))).rejects.toThrow(ConfigError);
    await expect(loadConfig("a.yml", repo({ "a.yml": "extends: [../secret.yml]" }))).rejects.toThrow(/inside the repository/);
    await expect(loadConfig("a.yml", repo({ "a.yml": "extends: [jev:nope]" }))).rejects.toThrow(/unknown preset/);
  });

  it("rejects invalid YAML and wrong setting types", async () => {
    await expect(loadConfig("a.yml", repo({ "a.yml": "rules: [" }))).rejects.toThrow(/invalid YAML/);
    await expect(loadConfig("a.yml", repo({ "a.yml": "budget: { concurrency: many }" }))).rejects.toThrow(ConfigError);
  });

  it("accepts the documented example config", async () => {
    const example = readFileSync("examples/jev-review.yml", "utf8");
    const { config } = await loadConfig("c.yml", repo({ "c.yml": example }));
    const byId = new Map(config.rules.map((r) => [r.id, r]));
    expect(byId.has("corr.todo-added")).toBe(false);
    expect(byId.get("team.error-response")?.type).toBe("choice");
    expect(config.dimensions.map((d) => [d.id, d.weight])).toEqual([["change_focus", 1], ["readability", 2]]);
  });

  it("fills preset variables from the project config", async () => {
    const preset = `
vars:
  main_paths: ["src/main/**"]
rules:
  - id: p.validate
    type: noul
    paths: ["{{vars.main_paths}}", "lib/**"]
    instructions: "Is input checked with {{vars.validator}}? Allowed: {{vars.allowed}}. Also {{vars.allowed|and}}."
  - id: p.pattern
    type: pattern
    field: added_lines
    fires_when: match
    regex: '\\b({{vars.banned|regex}})\\('
`;
    const cfg = `
extends: [./preset.yml]
vars:
  validator: validatePathAccess()
  allowed: [PTY cleanup, JSON.parse, file cleanup]
  banned: [readFileSync, exec.Sync]
`;
    const { config } = await loadConfig("c.yml", repo({ "c.yml": cfg, "preset.yml": preset }));
    const [rule, pattern] = config.rules.filter((r) => r.id.startsWith("p."));
    expect(rule!.paths).toEqual(["src/main/**", "lib/**"]);
    expect(rule!.instructions).toBe(
      "Is input checked with validatePathAccess()? Allowed: PTY cleanup, JSON.parse or file cleanup. Also PTY cleanup, JSON.parse and file cleanup.",
    );
    expect(pattern!.type === "pattern" && pattern!.regex).toBe("\\b(readFileSync|exec\\.Sync)\\(");
  });

  it("lets projects override preset variable defaults", async () => {
    const preset = `vars: { dir: ["src/**"] }\nrules:\n  - id: p.r\n    type: noul\n    paths: ["{{vars.dir}}"]\n    instructions: x\n`;
    const cfg = `extends: [./preset.yml]\nvars: { dir: ["app/**", "lib/**"] }\n`;
    const { config } = await loadConfig("c.yml", repo({ "c.yml": cfg, "preset.yml": preset }));
    expect(config.rules.filter((r) => r.id === "p.r")[0]!.paths).toEqual(["app/**", "lib/**"]);
  });

  it("names the missing variable, and ignores it when the rule is disabled", async () => {
    const preset = `rules:\n  - id: p.r\n    type: noul\n    instructions: Uses {{vars.helper}}?\n`;
    await expect(loadConfig("c.yml", repo({ "c.yml": "extends: [./p.yml]\n", "p.yml": preset }))).rejects.toThrow(
      /rule p.r: set vars.helper/,
    );
    const off = "extends: [./p.yml]\nrules:\n  - id: p.r\n    enabled: false\n";
    await expect(loadConfig("c.yml", repo({ "c.yml": off, "p.yml": preset }))).resolves.toBeDefined();
  });

  it("builds the same preset rules differently for the canopy and control configs", async () => {
    const load = async (file: string) => {
      const text = readFileSync(file, "utf8");
      return (await loadConfig("c.yml", repo({ "c.yml": text }))).config;
    };
    const canopy = await load("examples/canopy/jev-review.yml");
    const control = await load("eval/control/jev-review.yml");
    const rule = (cfg: typeof canopy, id: string) => cfg.rules.filter((r) => r.id === id)[0]!;

    const canopyTry = rule(canopy, "errors.try-catch-outside-boundaries");
    const controlTry = rule(control, "errors.try-catch-outside-boundaries");
    expect(canopyTry.paths).toEqual(["src/main/**/*.ts"]);
    expect(controlTry.paths).toEqual(["server/**/*.ts"]);
    expect(JSON.stringify(canopyTry.instructions)).toContain("contextBridge initialization");
    expect(JSON.stringify(controlTry.instructions)).toContain("closing sockets, files or servers during shutdown");
    expect(JSON.stringify((canopyTry as { criteria?: unknown }).criteria)).toContain("fromExternalCall()");
    expect(JSON.stringify((controlTry as { criteria?: unknown }).criteria)).toContain("Result.fromPromise()");

    const canopyIpc = rule(canopy, "electron.ipc-unvalidated-input");
    expect(JSON.stringify(canopyIpc.instructions)).toContain("validatePathAccess()");
    expect(JSON.stringify(rule(control, "electron.ipc-unvalidated-input").instructions)).toContain("assertSafePath()");

    const prefix = rule(control, "title.prefix");
    expect(prefix.type === "pattern" && prefix.regex).toBe("^(feature|bugfix|ops|docs)(\\([^)]+\\))?: ");
    // Every rule is fully interpolated.
    for (const cfg of [canopy, control]) expect(JSON.stringify(cfg.rules)).not.toContain("{{vars.");
  });
});
