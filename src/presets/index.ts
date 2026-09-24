import asyncState from "./async-state.yml";
import base from "./base.yml";
import codeSlop from "./code-slop.yml";
import conventionalTitle from "./conventional-title.yml";
import prTemplate from "./pr-template.yml";
import docsSync from "./docs-sync.yml";
import resultErrors from "./result-errors.yml";
import electron from "./electron.yml";
import maintainability from "./maintainability.yml";
import svelte5 from "./svelte5.yml";
import theming from "./theming.yml";
import patternMatching from "./pattern-matching.yml";
import typeHygiene from "./type-hygiene.yml";
import correctness from "./correctness.yml";
import prDescription from "./pr-description.yml";
import recommended from "./recommended.yml";
import security from "./security.yml";
import style from "./style.yml";
import tests from "./tests.yml";

/** Built-in presets, referenced from config as `extends: ["jev:<name>"]`. */
export const PRESETS: Record<string, string> = {
  base,
  security,
  correctness,
  tests,
  style,
  recommended,
  "pr-description": prDescription,
  "conventional-title": conventionalTitle,
  "pr-template": prTemplate,
  "docs-sync": docsSync,
  "result-errors": resultErrors,
  electron,
  svelte5,
  theming,
  "pattern-matching": patternMatching,
  "type-hygiene": typeHygiene,
  "async-state": asyncState,
  "code-slop": codeSlop,
  maintainability,
};
