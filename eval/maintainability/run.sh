#!/usr/bin/env bash
# Measure jev:maintainability on the synthetic and the canopy-desktop rows, then list every row
# where Jev disagrees with the hand label. Calls the TypeSafe API (TYPESAFE_API_KEY from .env).
#
#   eval/maintainability/run.sh                          # both datasets, every rule
#   eval/maintainability/run.sh --rule maint.magic-delay # one rule
#   eval/maintainability/run.sh --only real              # real | syn
#   eval/maintainability/run.sh --only challenge         # fresh mutations and counterexamples
#   eval/maintainability/run.sh --replay <report-dir>     # same questions, new thresholds; no API
#   eval/maintainability/run.sh --rebuild                # rebuild the canopy rows from labels first
#   eval/maintainability/run.sh --config my.yml          # a changed preset or overrides
#
# Output: the calibration tables on stdout, and eval/reports/maintainability-<time>/ with the
# report, the per-row dump and the disagreement list for each dataset.
set -euo pipefail
cd "$(dirname "$0")/../.."

rule="" only="" rebuild=0 config="eval/maintainability/jev-review.yml" replay=""
extra=(--beta 0.5)
while [ $# -gt 0 ]; do
  case "$1" in
    --rule) rule="$2"; shift 2 ;;
    --only) only="$2"; shift 2 ;;
    --rebuild) rebuild=1; shift ;;
    --config) config="$2"; shift 2 ;;
    --threshold) extra+=(--threshold "$2"); shift 2 ;;
    --replay) replay="$2"; shift 2 ;;
    --no-suggest) extra+=(--no-suggest); shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
case "$only" in ""|real|syn|challenge) ;; *) echo "--only must be real, syn or challenge" >&2; exit 2 ;; esac

data_dir=${CANOPY_DATA:-/tmp/canopy-data}
if [ "$rebuild" = 1 ]; then
  [ -f "$data_dir/pr_files.json" ] || python3 eval/canopy/fetch_data.py "$data_dir"
  python3 eval/maintainability/build_canopy.py "$data_dir"
fi

mkdir -p eval/reports
out=$(mktemp -d "eval/reports/maintainability-$(date +%Y%m%dT%H%M%S)-XXXXXX")
cp "$config" "$out/config.yml"
cp src/presets/maintainability.yml "$out/preset.yml"

run() {
  local name="$1" data="$2"
  if [ -n "$rule" ]; then
    # Keep only rows labeled for this rule, and only that label.
    jq -c --arg rule "$rule" 'select(.labels[$rule]) | .labels = {($rule): .labels[$rule]}' "$data" > "$out/$name.jsonl"
  else
    cp "$data" "$out/$name.jsonl"
  fi
  data="$out/$name.jsonl"
  local args=(--data "$data" --config "$config" --dump "$out/$name-dump.jsonl" "${extra[@]}")
  if [ -n "$replay" ]; then args+=(--replay "$replay/$name-dump.jsonl.answers.json"); fi
  echo "== $name: $data" >&2
  npm run --silent calibrate -- "${args[@]}" \
    | tee "$out/$name-report.md"
  python3 eval/maintainability/disagreements.py "$data" "$out/$name-dump.jsonl" \
    | tee "$out/$name-disagreements.md"
}

if [ -z "$only" ] || [ "$only" = "syn" ]; then run syn eval/datasets/maintainability.jsonl; fi
if [ -z "$only" ] || [ "$only" = "real" ]; then run real eval/datasets/canopy-maintainability.jsonl; fi
if [ "$only" = "challenge" ]; then run challenge eval/datasets/maintainability-challenge.jsonl; fi
echo "Saved $out" >&2
