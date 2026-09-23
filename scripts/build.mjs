import { build } from "esbuild";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  loader: { ".yml": "text" },
  define: { JEV_VERSION: JSON.stringify(version) },
  legalComments: "none",
  sourcemap: false,
  logLevel: "info",
};
// Some bundled CommonJS deps call require(); give ESM output a working one.
const requireShim = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

// GitHub Action entry (action.yml runs dist/index.js).
await build({ ...shared, entryPoints: ["src/main.ts"], outfile: "dist/index.js", banner: { js: requireShim } });
// npm CLI entry (package.json bin).
await build({ ...shared, entryPoints: ["src/cli/bin.ts"], outfile: "dist/cli.js", banner: { js: `#!/usr/bin/env node\n${requireShim}` } });
