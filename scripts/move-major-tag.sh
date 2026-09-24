#!/bin/sh
# Run by semantic-release in CI: point the major tag (v1) that action users pin at release $1
# (for example 1.2.3). Moving a tag needs --force; nothing else is pushed.
set -eu
major="v${1%%.*}"
git tag -f "$major" "v$1"
git push --force origin "refs/tags/$major"
