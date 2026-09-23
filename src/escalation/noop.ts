import type { Escalator } from "./types.js";

/** v1 default: uncertain findings stay "needs human". */
export const noopEscalator: Escalator = {
  name: "none",
  escalate: async (findings) => findings,
};
