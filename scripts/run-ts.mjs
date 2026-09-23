// Run a TypeScript script that imports the YAML presets (tsx cannot load .yml as text).
// Usage: node scripts/run-ts.mjs scripts/calibrate.ts [args...]
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [entry, ...args] = process.argv.slice(2);
const outdir = resolve("node_modules/.cache/jev-scripts");
mkdirSync(outdir, { recursive: true });
const outfile = resolve(outdir, basename(entry).replace(/\.ts$/, ".mjs"));
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  loader: { ".yml": "text" },
  logLevel: "error",
});
process.argv = [process.argv[0], entry, ...args];
await import(pathToFileURL(outfile).href);
