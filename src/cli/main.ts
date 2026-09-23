import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ResolvedConfig } from "../config/schema.js";
import { filesFromGitDiff } from "../diff/gitDiff.js";
import { createJevPort, type JevClientOptions } from "../jev/jevPort.js";
import type { JevPort } from "../jev/evaluate.js";
import type { GitHubPort } from "../ports.js";
import { renderSarif } from "../report/sarif.js";
import { renderSummary } from "../report/summary.js";
import { renderText, reportJson } from "../report/text.js";
import { run, type RunResult } from "../run.js";
import type { PrInfo } from "../types.js";
import { VERSION } from "../version.js";
import { githubRepo, localChange, systemGit, type Git } from "./git.js";
import { localGitHub } from "./localPort.js";
import { githubPullRequest, githubToken } from "./pr.js";

export const HELP = `jev-review: pull request review with TypeSafe Jev

Usage:
  npx @itsoltech/jev-code-review [options]            review the local change
  npx @itsoltech/jev-code-review --pr 123 [options]   review a GitHub pull request

Local change (default):
  --base <ref>         compare with the merge base of HEAD and <ref>
                       (default: origin's default branch, then main or master)
  --staged             review only staged changes (for a pre-commit hook)
  --diff <path|->      review a unified diff from a file or stdin instead of git
  --title <text>       pull request title (default: oldest commit subject)
  --body-file <path>   pull request description (default: the commit messages)

GitHub pull request:
  --pr <number>        read the diff, title and description through the GitHub API
  --repo <owner/name>  repository (default: the origin remote)
  --post               publish the review on the pull request like the GitHub Action
                       (comments, review, label, check); without it nothing is written
                       Token: GITHUB_TOKEN, GH_TOKEN or \`gh auth token\`.

Options:
  --config <path>      config file (default: .github/jev-review.yml; with --pr, read from
                       the base commit unless this option is given)
  --model <id>         override the config's model
  --format <format>    text (default), markdown, json or sarif
  --output <path>      write the result to a file instead of stdout
  --env-file <path>    load environment variables (default: .env when present and
                       TYPESAFE_API_KEY is not set)
  -h, --help           show this help
  -v, --version        show the version

Environment:
  TYPESAFE_API_KEY     TypeSafe API key (required)

Exit codes: 0 reviewed, 1 the check fails (policy.fail_check or on_error: fail),
2 usage, config or setup error.`;

const FORMATS = ["text", "markdown", "json", "sarif"] as const;
type Format = (typeof FORMATS)[number];

export interface CliIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  git: Git;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Reads all of stdin for `--diff -`; injected in tests. */
  stdin?: () => string;
  /** Injected in tests. */
  createJev?: (cfg: ResolvedConfig, apiKey: string) => JevPort;
  github?: (token: string, repo: string, pr: number) => Promise<{ gh: GitHubPort; pr: PrInfo }>;
}

class UsageError extends Error {}

function options(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        base: { type: "string" },
        staged: { type: "boolean" },
        diff: { type: "string" },
        title: { type: "string" },
        "body-file": { type: "string" },
        pr: { type: "string" },
        repo: { type: "string" },
        post: { type: "boolean" },
        config: { type: "string" },
        model: { type: "string" },
        format: { type: "string" },
        output: { type: "string" },
        "env-file": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    }).values;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function render(result: RunResult, format: Format): string {
  const report = result.report;
  if (!report) {
    const message = result.message ?? result.summary;
    return format === "json" || format === "sarif" ? JSON.stringify({ status: result.status, message }, null, 2) : message;
  }
  switch (format) {
    case "text":
      return renderText(report);
    case "markdown":
      return renderSummary(report, new Set());
    case "json":
      return JSON.stringify({ status: result.status, ...reportJson(report) }, null, 2);
    case "sarif":
      return JSON.stringify(renderSarif(report), null, 2);
  }
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    return await review(argv, io);
  } catch (e) {
    io.stderr(`jev-review: ${(e as Error).message}${e instanceof UsageError ? "\nRun with --help for usage." : ""}`);
    return 2;
  }
}

async function review(argv: string[], io: CliIo): Promise<number> {
  const opts = options(argv);
  if (opts.help) return io.stdout(HELP), 0;
  if (opts.version) return io.stdout(VERSION), 0;

  const format = (opts.format ?? "text") as Format;
  if (!FORMATS.includes(format)) throw new UsageError(`--format must be one of ${FORMATS.join(", ")}`);
  if (opts.post && !opts.pr) throw new UsageError("--post needs --pr");
  if (opts.pr && (opts.base || opts.staged || opts.diff || opts.title || opts["body-file"])) {
    throw new UsageError("--base, --staged, --diff, --title and --body-file apply to a local change, not to --pr");
  }
  if (opts.diff && (opts.base || opts.staged)) throw new UsageError("--diff cannot be combined with --base or --staged");

  const envFile = opts["env-file"] ?? (!io.env.TYPESAFE_API_KEY && existsSync(resolve(io.cwd, ".env")) ? ".env" : undefined);
  if (envFile) loadEnv(resolve(io.cwd, envFile), io.env);
  const apiKey = io.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("set TYPESAFE_API_KEY (or put it in .env)");

  const localConfig = opts.config ? resolve(io.cwd, opts.config) : undefined;
  let gh: GitHubPort;
  let pr: PrInfo;
  if (opts.pr) {
    const number = Number(opts.pr);
    if (!Number.isInteger(number) || number <= 0) throw new UsageError(`--pr must be a pull request number, got "${opts.pr}"`);
    const repo = opts.repo ?? githubRepo(io.git);
    if (!repo) throw new UsageError("origin is not a GitHub repository; pass --repo owner/name");
    const token = githubToken(io.env);
    if (!token) throw new Error("set GITHUB_TOKEN or GH_TOKEN, or log in with `gh auth login`");
    ({ gh, pr } = await (io.github ?? githubPullRequest)(token, repo, number));
    if (localConfig) {
      // The config (and its extends) come from disk; other files still come from the pull request.
      const remote = gh;
      const configSha = pr.baseSha;
      gh = { ...remote, readFile: (path, ref) => (ref === configSha ? Promise.resolve(readLocal(io.cwd, path)) : remote.readFile(path, ref)) };
    }
    io.stderr(`Reviewing ${repo}#${number}: ${pr.title}`);
  } else if (opts.diff) {
    const files = filesFromGitDiff(opts.diff === "-" ? (io.stdin ?? (() => readFileSync(0, "utf8")))() : readFileSync(resolve(io.cwd, opts.diff), "utf8"));
    if (!files.length) {
      io.stderr("No files in the diff.");
      return 0;
    }
    io.stderr(`Reviewing ${files.length} file(s) from ${opts.diff === "-" ? "stdin" : opts.diff}`);
    gh = localGitHub(files, (path) => readLocal(io.cwd, path));
    pr = localPr(opts.title ?? "Local change", opts["body-file"] ? readFileSync(resolve(io.cwd, opts["body-file"]), "utf8") : "", "diff", "diff");
  } else {
    const root = io.git("rev-parse", "--show-toplevel").trim();
    const change = localChange(io.git, { base: opts.base, staged: opts.staged });
    if (!change.files.length) {
      io.stderr(`No changes against ${change.range}.`);
      return 0;
    }
    if (change.untracked) io.stderr(`${change.untracked} untracked file(s) are not reviewed; git add them to include them.`);
    io.stderr(`Reviewing ${change.files.length} file(s): ${change.range}`);
    gh = localGitHub(change.files, (path) => readLocal(root, path));
    const body = opts["body-file"] ? readFileSync(resolve(io.cwd, opts["body-file"]), "utf8") : change.body;
    pr = localPr(opts.title ?? change.title, body, change.baseSha, change.headSha);
  }

  const createJev =
    io.createJev ??
    ((cfg: ResolvedConfig, key: string) =>
      createJevPort({
        apiKey: key,
        timeoutMs: cfg.budget.request_timeout_seconds * 1000,
        logger: { debug() {}, info() {}, warn: (m: string) => io.stderr(m), error: (m: string) => io.stderr(m) },
      } satisfies JevClientOptions));

  const result = await run(
    {
      configPath: localConfig ?? ".github/jev-review.yml",
      configRef: "base",
      model: opts.model,
      dryRun: !opts.post,
      // A person runs the CLI on purpose; the fork guard protects secrets in CI only.
      allowForkPrs: true,
    },
    {
      gh,
      pr,
      createJev: (cfg) => createJev(cfg, apiKey),
      log: { info: (m) => io.stderr(m), warning: (m) => io.stderr(`warning: ${m}`) },
    },
  );

  const out = render(result, format);
  if (opts.output) writeFileSync(resolve(io.cwd, opts.output), `${out}\n`);
  else io.stdout(out);
  if (result.status === "config_error") return 2;
  return result.failed ? 1 : 0;
}

const localPr = (title: string, body: string, baseSha: string, headSha: string): PrInfo => ({
  number: 0,
  title,
  body,
  author: "local",
  draft: false,
  labels: [],
  baseSha,
  headSha,
  isFork: false,
});

function readLocal(root: string, path: string): string | undefined {
  const full = isAbsolute(path) ? path : resolve(root, path);
  return existsSync(full) ? readFileSync(full, "utf8") : undefined;
}

/** KEY=value lines; existing variables win, like node --env-file. */
function loadEnv(path: string, env: NodeJS.ProcessEnv): void {
  if (!existsSync(path)) throw new UsageError(`env file not found: ${path}`);
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || env[m[1]!] !== undefined) continue;
    env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
}

export const systemIo = (): CliIo => ({
  cwd: process.cwd(),
  env: process.env,
  git: systemGit,
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
});
