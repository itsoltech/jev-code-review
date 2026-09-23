import type { context as ghContext } from "@actions/github";
import type { PrInfo } from "../types.js";

type Context = typeof ghContext;

/** The pull request fields the review needs, as in the event payload and the pulls.get response. */
export interface PullPayload {
  number: number;
  title?: string;
  body?: string | null;
  draft?: boolean;
  user?: { login?: string };
  labels?: { name?: string }[];
  base: { sha: string; repo: { full_name: string } };
  head: { sha: string; repo: { full_name: string } | null };
}

/** Read PR details from the event payload; undefined when the event is not about a pull request. */
export function prFromContext(context: Context): PrInfo | undefined {
  const pull = context.payload.pull_request as PullPayload | undefined;
  return pull ? prFromPull(pull) : undefined;
}

export function prFromPull(pull: PullPayload): PrInfo {
  return {
    number: pull.number,
    title: pull.title ?? "",
    body: pull.body ?? "",
    author: pull.user?.login ?? "",
    draft: pull.draft ?? false,
    labels: (pull.labels ?? []).flatMap((l) => (l.name ? [l.name] : [])),
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    // A deleted fork has no head repo; treat it as a fork.
    isFork: pull.head.repo?.full_name !== pull.base.repo.full_name,
  };
}
