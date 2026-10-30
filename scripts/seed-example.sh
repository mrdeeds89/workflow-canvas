#!/usr/bin/env bash
# Load examples/research-workflow.json into a running service as a new
# workflow, filling in the card fields the example leaves out.
# Usage: scripts/seed-example.sh [base-url]   (default http://127.0.0.1:8787)
set -euo pipefail

BASE="${1:-http://127.0.0.1:8787}"
EXAMPLE="$(dirname "$0")/../examples/research-workflow.json"

created="$(curl -sS --fail -X POST -H 'content-type: application/json' \
  -d "$(jq '{title}' "$EXAMPLE")" "${BASE}/api/workflows")"
id="$(jq -r .id <<<"$created")"

body="$(jq --slurpfile ex "$EXAMPLE" '
  .nodes = [$ex[0].nodes[] | {
      instructions: "", spec: "", inputs: [], outputs: [], acceptanceCriteria: [], inferred: false
    } + .]
  | .edges = [$ex[0].edges[] | {inferred: false} + .]
' <<<"$created")"

curl -sS --fail -o /dev/null -X PUT -H 'content-type: application/json' \
  -d "$body" "${BASE}/api/workflows/${id}"
echo "$id"
