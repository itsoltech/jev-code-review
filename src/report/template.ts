export type TemplateValue = string | number | boolean | undefined | null | { [k: string]: TemplateValue };
export type TemplateContext = Record<string, TemplateValue>;

const FILTERS: Record<string, (v: TemplateValue) => string> = {
  pct: (v) => (typeof v === "number" ? `${Math.round(v * 100)}%` : ""),
  fixed2: (v) => (typeof v === "number" ? v.toFixed(2) : ""),
  upper: (v) => String(v ?? "").toUpperCase(),
};

function lookup(ctx: TemplateContext, path: string): TemplateValue {
  let cur: TemplateValue = ctx;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

const truthy = (v: TemplateValue) => v !== undefined && v !== null && v !== false && v !== "" && v !== 0;

/**
 * Minimal mustache-style renderer: `{{a.b}}`, `{{x|pct}}`, `{{#flag}}..{{/flag}}`, `{{^flag}}..{{/flag}}`.
 * Values are inserted as-is; anything that comes from the diff must be escaped by the caller.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  const sections = template.replace(
    /\{\{([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}\n?/g,
    (_, kind: string, name: string, body: string) => (truthy(lookup(ctx, name)) === (kind === "#") ? body : ""),
  );
  return sections.replace(/\{\{\s*([\w.]+)(?:\|(\w+))?\s*\}\}/g, (_, name: string, filter?: string) => {
    const value = lookup(ctx, name);
    if (filter) return FILTERS[filter]?.(value) ?? "";
    return value === undefined || value === null || typeof value === "object" ? "" : String(value);
  });
}

/** Render untrusted code as a fenced block that cannot break out or ping people. */
export function codeSnippet(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Escape text from the diff for inline markdown (table cells, lists). */
export function inlineCode(text: string, max = 80): string {
  const short = text.trim().length > max ? `${text.trim().slice(0, max)}…` : text.trim();
  return `\`${short.replace(/`/g, "'").replace(/\|/g, "\\|")}\``;
}
