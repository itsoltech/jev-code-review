import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      // Mirror esbuild's text loader so presets import as raw YAML strings.
      name: "yaml-text",
      load(id) {
        if (id.endsWith(".yml")) {
          return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
        }
        return null;
      },
    },
  ],
  test: { include: ["test/**/*.test.ts"] },
});
