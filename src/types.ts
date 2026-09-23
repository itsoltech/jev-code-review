import type { ChoiceResponse, NoulResponse, ScoreResponse } from "@typesafe-ai/sdk";
import type { Hunk } from "./diff/parse.js";

export interface PrInfo {
  number: number;
  title: string;
  body: string;
  author: string;
  draft: boolean;
  labels: string[];
  baseSha: string;
  headSha: string;
  isFork: boolean;
}

export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** Missing for binary files and diffs GitHub considers too large. */
  patch?: string;
}

export type SkipReason = "removed" | "excluded" | "no_patch" | "too_large" | "budget";

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

/** An added line a comment can be attached to. */
export interface Location {
  path: string;
  line: number;
  text: string;
}

/** One unit of state sent to Jev. */
export type Subject =
  | { kind: "hunk"; key: string; path: string; hunk: Hunk; addedLines: number; locations: Map<string, Location> }
  | { kind: "file"; key: string; path: string; hunks: Hunk[]; addedLines: number; locations: Map<string, Location> }
  | { kind: "pr"; key: string };

export type Answer = NoulResponse | ChoiceResponse | ScoreResponse;

export type QuestionRole = "verdict" | "where" | "dimension";

export interface QuestionMeta {
  subject: Subject;
  role: QuestionRole;
  /** Rule id for verdict and where questions, dimension id for dimension questions. */
  target: string;
}
