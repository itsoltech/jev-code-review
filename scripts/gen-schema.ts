import { writeFileSync } from "node:fs";
import { z } from "zod";
import { ConfigFile } from "../src/config/schema.js";

// "input" mode: fields with defaults are optional, which is what people write in YAML.
const schema = z.toJSONSchema(ConfigFile, { io: "input", unrepresentable: "any" });
const out = {
  ...schema,
  title: "Jev code review config",
  description: "Configuration for the jev-code-review GitHub Action (.github/jev-review.yml).",
};
writeFileSync("schema/jev-review.schema.json", `${JSON.stringify(out, null, 2)}\n`);
console.log("wrote schema/jev-review.schema.json");
