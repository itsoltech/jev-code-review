import { execFileSync } from "node:child_process";
import { filesFromGitDiff } from "../diff/gitDiff.js";
import type { ChangedFile } from "../types.js";

/** Runs git in the working directory and returns stdout; throws on a non-zero exit. */
export type Git = (...args: string[]) => string;

export const systemGit: Git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

const tryGit = (git: Git, ...args: string[]) => {
  try {
    return git(...args).trim();
  } catch {
    return undefined;
  }
};

/** The branch the change is compared with: origin's default branch, then main or master. */
export function defaultBase(git: Git): string {
  const originHead = tryGit(git, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  if (originHead) return originHead;
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (tryGit(git, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)) return ref;
  }
  throw new Error("Cannot find the base branch (no origin/HEAD, main or master); pass --base <ref>.");
}

export interface LocalChange {
  files: ChangedFile[];
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  /** Human-readable description of what was compared, for logs. */
  range: string;
  untracked: number;
}

/**
 * The local change as a pull request would show it: the working tree (or only the index with
 * `staged`) against the merge base of HEAD and `base`. Untracked files are not part of git diff.
 */
export function localChange(git: Git, opts: { base?: string; staged?: boolean }): LocalChange {
  const base = opts.base ?? defaultBase(git);
  const headSha = git("rev-parse", "HEAD").trim();
  const baseSha = tryGit(git, "merge-base", base, "HEAD") ?? git("rev-parse", "--verify", `${base}^{commit}`).trim();
  const diffArgs = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];
  const diff = opts.staged ? git(...diffArgs, "--cached") : git(...diffArgs, baseSha);

  // Oldest commit subject as the title, every commit message as the description.
  const log = git("log", "--reverse", "--format=%s%x1f%b%x1e", `${baseSha}..HEAD`);
  const commits = log
    .split("\x1e")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [subject = "", body = ""] = c.split("\x1f");
      return { subject: subject.trim(), body: body.trim() };
    });
  const title = opts.staged || !commits.length ? "Uncommitted changes" : commits[0]!.subject;
  const body = opts.staged ? "" : commits.map((c) => (c.body ? `${c.subject}\n\n${c.body}` : c.subject)).join("\n\n");
  const untracked = (tryGit(git, "ls-files", "--others", "--exclude-standard") ?? "").split("\n").filter(Boolean).length;
  return {
    files: filesFromGitDiff(diff),
    title,
    body,
    baseSha,
    headSha,
    range: opts.staged ? "staged changes" : `${base} (merge base ${baseSha.slice(0, 7)})...working tree`,
    untracked,
  };
}

/** owner/name of the GitHub remote `origin`, if it is one. */
export function githubRepo(git: Git): string | undefined {
  const url = tryGit(git, "remote", "get-url", "origin");
  return url ? /github\.com[:/]([^/]+\/[^/]+?)(\.git)?\/?$/.exec(url)?.[1] : undefined;
}
