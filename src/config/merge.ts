type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep-merge plain objects; arrays and scalars from `over` replace those in `base`. */
export function deepMerge(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    out[key] = isObj(prev) && isObj(value) ? deepMerge(prev, value) : value;
  }
  return out;
}

/**
 * Merge entries by `id`. A later entry with a known id replaces the fields it sets
 * (shallow, so `criteria` is swapped as a whole, never mixed); a new id is appended.
 */
export function mergeById(base: Obj[], over: Obj[]): Obj[] {
  const out = base.map((e) => ({ ...e }));
  for (const entry of over) {
    const i = out.findIndex((e) => e.id === entry.id);
    if (i >= 0) out[i] = { ...out[i], ...entry };
    else out.push({ ...entry });
  }
  return out;
}

/** Merge one config layer over another: settings deep, rules and dimensions by id. */
export function mergeLayers(base: Obj, over: Obj): Obj {
  const { rules: baseRules, dimensions: baseDims, ...baseRest } = base;
  const { rules: overRules, dimensions: overDims, extends: _ext, $schema: _s, ...overRest } = over;
  return {
    ...deepMerge(baseRest, overRest),
    rules: mergeById(asArray(baseRules), asArray(overRules)),
    dimensions: mergeById(asArray(baseDims), asArray(overDims)),
  };
}

function asArray(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter(isObj) : [];
}
