import { execFileSync } from "node:child_process";
import { getOctokit } from "@actions/github";
import { prFromPull, type PullPayload } from "../github/context.js";
import { createGitHubPort } from "../github/octokitPort.js";
import type { GitHubPort } from "../ports.js";
import type { PrInfo } from "../types.js";

/** GITHUB_TOKEN or GH_TOKEN, then the GitHub CLI's login. */
export function githubToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (token) return token;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function parseRepo(name: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = name.split("/");
  if (!owner || !repo || rest.length) throw new Error(`--repo must be owner/name, got "${name}"`);
  return { owner, repo };
}

export async function githubPullRequest(token: string, repoName: string, number: number): Promise<{ gh: GitHubPort; pr: PrInfo }> {
  const octokit = getOctokit(token);
  const repo = parseRepo(repoName);
  const { data } = await octokit.rest.pulls.get({ ...repo, pull_number: number });
  return { gh: createGitHubPort(octokit, repo, number), pr: prFromPull(data as unknown as PullPayload) };
}
