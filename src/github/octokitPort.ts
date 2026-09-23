import type { getOctokit } from "@actions/github";
import type { GitHubPort } from "../ports.js";
import type { ChangedFile } from "../types.js";

type Octokit = ReturnType<typeof getOctokit>;

/** GitHub caps pulls.listFiles at 3000 files. */
const MAX_FILES = 3000;

const status = (e: unknown) => (e as { status?: number }).status;

export function createGitHubPort(octokit: Octokit, repo: { owner: string; repo: string }, pullNumber: number): GitHubPort {
  const pr = { ...repo, pull_number: pullNumber };
  const issue = { ...repo, issue_number: pullNumber };

  return {
    async readFile(path, ref) {
      try {
        const { data } = await octokit.rest.repos.getContent({ ...repo, path, ref });
        if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return undefined;
        return Buffer.from(data.content, "base64").toString("utf8");
      } catch (e) {
        if (status(e) === 404) return undefined;
        throw e;
      }
    },

    async listFiles() {
      const files: ChangedFile[] = [];
      for await (const page of octokit.paginate.iterator(octokit.rest.pulls.listFiles, { ...pr, per_page: 100 })) {
        for (const f of page.data) {
          files.push({
            path: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            ...(f.patch ? { patch: f.patch } : {}),
          });
        }
        if (files.length >= MAX_FILES) break;
      }
      return files;
    },

    async listReviewComments(marker) {
      const all = await octokit.paginate(octokit.rest.pulls.listReviewComments, { ...pr, per_page: 100 });
      return all.filter((c) => c.body.includes(marker)).map((c) => ({ id: c.id, body: c.body }));
    },

    async listReviews(marker) {
      const all = await octokit.paginate(octokit.rest.pulls.listReviews, { ...pr, per_page: 100 });
      return all
        .filter((r) => (r.body ?? "").includes(marker))
        .map((r) => ({ id: r.id, state: r.state, body: r.body ?? "" }));
    },

    async createReview({ commitId, event, body, comments }) {
      await octokit.rest.pulls.createReview({
        ...pr,
        commit_id: commitId,
        event,
        body,
        comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT" as const, body: c.body })),
      });
    },

    async dismissReview(id, message) {
      await octokit.rest.pulls.dismissReview({ ...pr, review_id: id, message });
    },

    async listIssueComments(marker) {
      const all = await octokit.paginate(octokit.rest.issues.listComments, { ...issue, per_page: 100 });
      return all.filter((c) => (c.body ?? "").includes(marker)).map((c) => ({ id: c.id, body: c.body ?? "" }));
    },

    async createIssueComment(body) {
      const { data } = await octokit.rest.issues.createComment({ ...issue, body });
      return data.id;
    },

    async updateIssueComment(id, body) {
      await octokit.rest.issues.updateComment({ ...repo, comment_id: id, body });
    },

    async addLabel(name) {
      await octokit.rest.issues.addLabels({ ...issue, labels: [name] });
    },

    async removeLabel(name) {
      try {
        await octokit.rest.issues.removeLabel({ ...issue, name });
      } catch (e) {
        if (status(e) !== 404) throw e; // label was not on the PR
      }
    },

    async createCheckRun({ headSha, conclusion, title, summary, annotations }) {
      // The API accepts at most 50 annotations per request.
      const first = annotations.slice(0, 50);
      const { data } = await octokit.rest.checks.create({
        ...repo,
        name: "Jev review",
        head_sha: headSha,
        status: "completed",
        conclusion,
        output: { title, summary: summary.slice(0, 65000), annotations: first },
      });
      for (let i = 50; i < annotations.length; i += 50) {
        await octokit.rest.checks.update({
          ...repo,
          check_run_id: data.id,
          output: { title, summary: summary.slice(0, 65000), annotations: annotations.slice(i, i + 50) },
        });
      }
    },
  };
}
