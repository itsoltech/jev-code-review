import type { ScoreResponse } from "@typesafe-ai/sdk";
import type { ResolvedConfig } from "../config/schema.js";
import type { Answer, QuestionMeta } from "../types.js";

export interface DimensionResult {
  id: string;
  weight: number;
  /** 0 (worst) to 1 (best); undefined when no confident answer was available. */
  value?: number;
  samples: number;
  lowConfidence: number;
}

export interface CompositeResult {
  /** Weighted mean of dimension values; undefined when no dimension has a value. */
  composite?: number;
  dimensions: DimensionResult[];
}

/**
 * Composite scoring: each dimension is normalized to 0..1, hunk dimensions are averaged
 * weighted by added lines, then dimensions are combined with the configured weights.
 */
export function computeComposite(
  meta: Map<string, QuestionMeta>,
  answers: Map<string, Answer>,
  cfg: ResolvedConfig,
): CompositeResult {
  const acc = new Map(cfg.dimensions.map((d) => [d.id, { sum: 0, weight: 0, samples: 0, lowConfidence: 0 }]));
  const dims = new Map(cfg.dimensions.map((d) => [d.id, d]));

  for (const [key, m] of meta) {
    if (m.role !== "dimension") continue;
    const dim = dims.get(m.target);
    const answer = answers.get(key) as ScoreResponse | undefined;
    const a = acc.get(m.target);
    if (!dim || !answer || !a) continue;
    if (answer.confidence < dim.min_confidence) {
      a.lowConfidence++;
      continue;
    }
    const w = m.subject.kind === "pr" ? 1 : Math.max(1, m.subject.addedLines);
    a.sum += (answer.score / (dim.criteria.length - 1)) * w;
    a.weight += w;
    a.samples++;
  }

  const dimensions: DimensionResult[] = cfg.dimensions.map((d) => {
    const a = acc.get(d.id)!;
    return {
      id: d.id,
      weight: d.weight,
      ...(a.weight > 0 ? { value: a.sum / a.weight } : {}),
      samples: a.samples,
      lowConfidence: a.lowConfidence,
    };
  });
  const scored = dimensions.filter((d) => d.value !== undefined);
  const totalWeight = scored.reduce((n, d) => n + d.weight, 0);
  return {
    dimensions,
    ...(totalWeight > 0 ? { composite: scored.reduce((n, d) => n + d.weight * d.value!, 0) / totalWeight } : {}),
  };
}
