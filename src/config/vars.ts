/**
 * Preset parameters. Presets write `{{vars.name}}` in any string of a rule or dimension and
 * projects set the values in `vars:`. Presets may declare defaults in their own `vars:`.
 *
 *   {{vars.x}}        string as is; list joined as "a, b or c"
 *   {{vars.x|and}}    list joined as "a, b and c"
 *   {{vars.x|semi}}   list joined as "a; b; c" (for items that are phrases)
 *   {{vars.x|regex}}  string as is; list items regex-escaped and joined with "|"
 *   {{vars.x?}}       optional: empty (or no list items) when the variable is not set
 *
 * A list field whose element is exactly "{{vars.x}}" (paths, exclude_paths, when globs) is
 * replaced by the list items.
 */
export type VarValue = string | string[];
export type Vars = Record<string, VarValue>;

const PLACEHOLDER = /\{\{\s*vars\.([A-Za-z0-9_]+)(\?)?(?:\|(\w+))?\s*\}\}/g;
const WHOLE = /^\{\{\s*vars\.([A-Za-z0-9_]+)(\?)?\s*\}\}$/;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function joinList(items: string[], word: string): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${word} ${items.at(-1)}`;
}

function render(value: VarValue, filter: string | undefined): string {
  switch (filter ?? "or") {
    case "or":
      return Array.isArray(value) ? joinList(value, "or") : value;
    case "and":
      return Array.isArray(value) ? joinList(value, "and") : value;
    case "semi":
      return Array.isArray(value) ? value.join("; ") : value;
    case "regex":
      return Array.isArray(value) ? value.map(escapeRegex).join("|") : value;
    default:
      throw new Error(`unknown filter "${filter}"`);
  }
}

/** Replace placeholders in every string of `entry`; `missing` collects unknown variable names. */
export function interpolate<T>(entry: T, vars: Vars, missing: Set<string>): T {
  const lookup = (name: string, optional: boolean): VarValue | undefined => {
    const v = vars[name];
    if (v === undefined || (Array.isArray(v) ? v.length === 0 : v === "")) {
      if (!optional) missing.add(name);
      return undefined;
    }
    return v;
  };

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return node.replace(PLACEHOLDER, (_, name: string, optional: string | undefined, filter?: string) => {
        const v = lookup(name, Boolean(optional));
        return v === undefined ? "" : render(v, filter);
      });
    }
    if (Array.isArray(node)) {
      return node.flatMap((item) => {
        const whole = typeof item === "string" ? WHOLE.exec(item) : null;
        if (whole) {
          const v = lookup(whole[1]!, Boolean(whole[2]));
          return v === undefined ? [] : Array.isArray(v) ? v : [v];
        }
        return [walk(item)];
      });
    }
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(entry) as T;
}
