import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { PRESETS } from "../presets/index.js";
import { mergeLayers } from "./merge.js";
import { ConfigFile, Dimension, ResolvedConfig, Rule, Settings } from "./schema.js";
import { interpolate, type Vars } from "./vars.js";

/** Reads a repository file at a fixed ref; returns undefined when it does not exist. */
export type ReadFile = (path: string) => Promise<string | undefined>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

const PRESET_PREFIX = "jev:";
const MAX_DEPTH = 5;
/** Used when the repository has no config file. */
export const DEFAULT_EXTENDS = ["jev:recommended"];

export interface LoadedConfig {
  config: ResolvedConfig;
  /** Files and presets in merge order, for the summary. */
  sources: string[];
  warnings: string[];
}

export async function loadConfig(path: string, read: ReadFile): Promise<LoadedConfig> {
  const sources: string[] = [];
  const warnings: string[] = [];

  const text = await read(path);
  let merged: Record<string, unknown>;
  if (text === undefined) {
    warnings.push(`No config at ${path}; using ${DEFAULT_EXTENDS.join(", ")}.`);
    merged = await resolveLayer({ extends: DEFAULT_EXTENDS }, "(defaults)", read, sources, [], 0);
  } else {
    merged = await resolveLayer(parseLayer(text, path), path, read, sources, [], 0);
  }
  // The injection guard is always the first layer; files can tune it but it is present by default.
  const base = parseLayer(PRESETS.base!, "jev:base");
  merged = mergeLayers(mergeLayers({}, base), merged);
  sources.unshift("jev:base");

  return { config: validate(merged), sources, warnings };
}

async function resolveLayer(
  layer: Record<string, unknown>,
  name: string,
  read: ReadFile,
  sources: string[],
  stack: string[],
  depth: number,
): Promise<Record<string, unknown>> {
  if (depth > MAX_DEPTH) throw new ConfigError(`extends is nested deeper than ${MAX_DEPTH} levels at ${name}`);
  if (stack.includes(name)) throw new ConfigError(`extends cycle: ${[...stack, name].join(" -> ")}`);

  let acc: Record<string, unknown> = {};
  for (const ref of (layer.extends as string[] | undefined) ?? []) {
    const parent = await loadRef(ref, read);
    acc = mergeLayers(acc, await resolveLayer(parent, ref, read, sources, [...stack, name], depth + 1));
  }
  sources.push(name);
  return mergeLayers(acc, layer);
}

async function loadRef(ref: string, read: ReadFile): Promise<Record<string, unknown>> {
  if (ref.startsWith(PRESET_PREFIX)) {
    const preset = PRESETS[ref.slice(PRESET_PREFIX.length)];
    if (!preset) throw new ConfigError(`unknown preset ${ref}; available: ${Object.keys(PRESETS).map((p) => PRESET_PREFIX + p).join(", ")}`);
    return parseLayer(preset, ref);
  }
  if (/^[a-z]+:\/\//i.test(ref)) throw new ConfigError(`remote extends are not supported: ${ref}`);
  const path = ref.replace(/^\.\//, "");
  if (path.split("/").includes("..")) throw new ConfigError(`extends path must stay inside the repository: ${ref}`);
  const text = await read(path);
  if (text === undefined) throw new ConfigError(`extends file not found: ${ref}`);
  return parseLayer(text, ref);
}

export function parseLayer(text: string, name: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (e) {
    throw new ConfigError(`${name}: invalid YAML: ${(e as Error).message}`);
  }
  const result = ConfigFile.safeParse(raw);
  if (!result.success) throw new ConfigError(`${name}:\n${z.prettifyError(result.error)}`);
  return raw as Record<string, unknown>;
}

function validate(merged: Record<string, unknown>): ResolvedConfig {
  const { rules = [], dimensions = [], ...settings } = merged as {
    rules?: Record<string, unknown>[];
    dimensions?: Record<string, unknown>[];
  };
  const errors: string[] = [];

  const parsedSettings = Settings.safeParse(settings);
  if (!parsedSettings.success) errors.push(z.prettifyError(parsedSettings.error));

  const vars = (parsedSettings.success ? parsedSettings.data.vars : {}) as Vars;
  const parseEach = <T extends { enabled: boolean }>(entries: Record<string, unknown>[], schema: z.ZodType<T>, kind: string) =>
    entries
      .filter((e) => e.enabled !== false)
      .flatMap((raw) => {
        // Only enabled entries need their variables, so a disabled preset rule never fails the config.
        const missing = new Set<string>();
        let e: Record<string, unknown>;
        try {
          e = interpolate(raw, vars, missing);
        } catch (err) {
          errors.push(`${kind} ${String(raw.id)}: ${(err as Error).message}`);
          return [];
        }
        if (missing.size) {
          errors.push(`${kind} ${String(raw.id)}: set ${[...missing].map((m) => `vars.${m}`).join(", ")} in your config (or disable the ${kind})`);
          return [];
        }
        const r = schema.safeParse(e);
        if (r.success) return [r.data];
        errors.push(`${kind} ${String(raw.id)}:\n${z.prettifyError(r.error)}`);
        return [];
      });

  const parsedRules = parseEach(rules, Rule, "rule");
  const parsedDims = parseEach(dimensions, Dimension, "dimension");

  for (const rule of parsedRules) {
    if (rule.type === "pattern") {
      rule.scope = rule.field === "added_lines" ? "hunk" : "pr";
      rule.locate = rule.field === "added_lines";
      if (rule.field === "added_lines" && rule.fires_when !== "match") {
        errors.push(`rule ${rule.id}: added_lines patterns describe the problem; set fires_when: match`);
      }
    }
    if (rule.type === "choice") {
      const unknown = Object.keys(rule.finding_labels).filter((l) => !(l in rule.criteria));
      if (unknown.length) errors.push(`rule ${rule.id}: finding_labels not in criteria: ${unknown.join(", ")}`);
    }
  }

  if (errors.length || !parsedSettings.success) throw new ConfigError(errors.join("\n\n"));
  return ResolvedConfig.parse({ ...parsedSettings.data, rules: parsedRules, dimensions: parsedDims });
}
