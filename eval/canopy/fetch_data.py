"""Fetch canopy-desktop PR history with the GitHub CLI into DATA_DIR (default /tmp/canopy-data)."""

import concurrent.futures as cf
import json
import subprocess
import sys
from pathlib import Path

REPO = "itsoltech/canopy-desktop"
OWNER, NAME = REPO.split("/")
DATA = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/canopy-data")
DATA.mkdir(parents=True, exist_ok=True)


def gh(*args):
    return subprocess.check_output(["gh", *args]).decode()


def paginated(path):
    text = gh("api", "--paginate", path)
    return json.loads("[" + text.replace("][", ",")[1:-1] + "]")


QUERY = """query($cursor:String){ repository(owner:"%s", name:"%s") {
 pullRequests(states:MERGED, first:40, after:$cursor, orderBy:{field:CREATED_AT,direction:ASC}) {
  pageInfo{hasNextPage endCursor}
  nodes{ number title body createdAt author{login __typename}
   labels(first:30){nodes{name}}
   userContentEdits(first:30){nodes{createdAt diff}}
   timelineItems(first:30, itemTypes:[RENAMED_TITLE_EVENT]){nodes{... on RenamedTitleEvent{createdAt previousTitle currentTitle}}}
 }}}}""" % (OWNER, NAME)

prs, cursor = [], None
while True:
    args = ["api", "graphql", "-f", "query=" + QUERY] + (["-f", "cursor=" + cursor] if cursor else [])
    page = json.loads(gh(*args))["data"]["repository"]["pullRequests"]
    prs += page["nodes"]
    if not page["pageInfo"]["hasNextPage"]:
        break
    cursor = page["pageInfo"]["endCursor"]
(DATA / "prs_full.json").write_text(json.dumps(prs))


def files(n):
    return n, [
        {k: f.get(k) for k in ("status", "additions", "deletions", "patch")} | {"path": f["filename"]}
        for f in paginated(f"repos/{REPO}/pulls/{n}/files?per_page=100")
    ]


humans = [p["number"] for p in prs if (p["author"] or {}).get("__typename") != "Bot"]
with cf.ThreadPoolExecutor(8) as pool:
    (DATA / "pr_files.json").write_text(json.dumps(dict(pool.map(files, humans))))

for name, path in [("review_comments.json", "pulls/comments"), ("issue_comments.json", "issues/comments")]:
    (DATA / name).write_text(gh("api", "--paginate", f"repos/{REPO}/{path}?per_page=100"))

print(f"{len(prs)} merged PRs, files for {len(humans)} PRs written to {DATA}")
