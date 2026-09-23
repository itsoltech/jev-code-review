import { readFileSync } from "node:fs";
import { localGitHub as localPort } from "../src/cli/localPort.js";
import type { GitHubPort } from "../src/ports.js";
import type { ChangedFile } from "../src/types.js";

export { filesFromGitDiff } from "../src/diff/gitDiff.js";

/** Read-only GitHub port over local files; `configPath` is served as .github/jev-review.yml. */
export function localGitHub(files: ChangedFile[], configPath?: string): GitHubPort {
  return localPort(files, (path) => (configPath && path === ".github/jev-review.yml" ? readFileSync(configPath, "utf8") : undefined));
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function requireKey(): string {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    console.error("Set TYPESAFE_API_KEY first.");
    process.exit(2);
  }
  return key;
}

export const quietLogger = { debug() {}, info() {}, warn: console.warn, error: console.error };
