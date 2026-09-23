import type { ResolvedConfig } from "../config/schema.js";
import type { Finding } from "../policy/findings.js";
import type { PrInfo } from "../types.js";

/**
 * Second opinion for uncertain findings (for example a reasoning LLM or a human queue).
 * Called with the needs-human findings before the verdict; returns the findings to use instead.
 * A v2 escalator may confirm, drop or re-grade them.
 */
export interface Escalator {
  readonly name: string;
  escalate(findings: Finding[], ctx: { pr: PrInfo; config: ResolvedConfig }): Promise<Finding[]>;
}
