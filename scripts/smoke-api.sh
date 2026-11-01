#!/usr/bin/env bash
# Exercise the running design-time API: create, save, reload, restart, reload.
#
# This drives a real service over HTTP rather than asserting in-process, and
# checks that the published port is loopback-only. It does not test execution,
# because the service has no execution route.
#
# Usage: scripts/smoke-api.sh
# Requires: docker, curl, jq. Run from the repository root on the project VM.

set -euo pipefail

IMAGE="node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd"
CONTAINER="workflow-canvas-smoke"
PORT="${SMOKE_PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$(mktemp -d)"

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; exit 1; }

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

expect_status() {
  local description="$1" expected="$2" actual="$3"
  [[ "$actual" == "$expected" ]] || fail "$description (expected HTTP $expected, got $actual)"
  pass "$description"
}

status_of() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" \
      -H 'content-type: application/json' -d "$body" "${BASE}${path}"
  else
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" "${BASE}${path}"
  fi
}

echo "Starting API container, publishing to 127.0.0.1:${PORT} only"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -v "${REPO}:/work:ro" \
  -v "${DATA_DIR}:/data" \
  -w /work \
  -p "127.0.0.1:${PORT}:8787" \
  -e WORKFLOW_CANVAS_HOST=0.0.0.0 \
  -e WORKFLOW_CANVAS_PORT=8787 \
  -e WORKFLOW_CANVAS_DB=/data/canvas.sqlite \
  "$IMAGE" \
  node --experimental-strip-types --disable-warning=ExperimentalWarning src/http/main.ts >/dev/null

for _ in $(seq 1 50); do
  if curl -sS -o /dev/null "${BASE}/api/health" 2>/dev/null; then break; fi
  sleep 0.2
done

echo
echo "Health and exposure"
health="$(curl -sS "${BASE}/api/health")"
[[ "$(jq -r .status <<<"$health")" == "ok" ]] || fail "health reports ok"
pass "health reports ok"
[[ "$(jq -r .execution <<<"$health")" == "disabled" ]] || fail "health reports execution disabled"
pass "health reports execution disabled"

listeners="$(ss -ltn "sport = :${PORT}" | tail -n +2)"
if grep -qE '(0\.0\.0\.0|\*|\[::\]):'"${PORT}" <<<"$listeners"; then
  fail "port ${PORT} is published beyond loopback: ${listeners}"
fi
grep -q "127.0.0.1:${PORT}" <<<"$listeners" || fail "expected a loopback listener on ${PORT}"
pass "port ${PORT} is published on loopback only"

echo
echo "Create, save, reload"
created="$(curl -sS -X POST -H 'content-type: application/json' \
  -d '{"title":"Smoke research workflow"}' "${BASE}/api/workflows")"
id="$(jq -r .id <<<"$created")"
[[ -n "$id" && "$id" != "null" ]] || fail "create returns a workflow id"
pass "create returns a workflow id"
[[ "$(jq -r .revision <<<"$created")" == "1" ]] || fail "new workflow starts at revision 1"
pass "new workflow starts at revision 1"

edited="$(jq '.nodes = [{
  id: "read",
  title: "Read the source",
  description: "",
  type: "agent",
  position: { x: 120, y: 240 },
  owner: "agent",
  instructions: "Summarise the source document.",
  spec: "{\"prompt\": \"Write a draft from the research\"}",
  readiness: "configured",
  proposal: {
    agentOwns: ["Write the draft from the research only"],
    youOwn: ["Set tone, length and audience"]
  },
  setup: [{
    id: "s1",
    text: "Pick the review model",
    detail: "Use a different model from the draft agent so the review is independent.",
    link: "https://hermes-agent.nousresearch.com/docs",
    done: true
  }],
  inputs: [], outputs: [], acceptanceCriteria: [],
  inferred: false,
  run: {executor: "", skills: [], maxRuntimeMinutes: 30}, deliverTo: ""
}]' <<<"$created")"

saved="$(curl -sS -X PUT -H 'content-type: application/json' \
  -d "$edited" "${BASE}/api/workflows/${id}")"
[[ "$(jq -r .revision <<<"$saved")" == "2" ]] || fail "saving an edit bumps the revision to 2"
pass "saving an edit bumps the revision to 2"

reloaded="$(curl -sS "${BASE}/api/workflows/${id}")"
[[ "$(jq -r '.nodes[0].title' <<<"$reloaded")" == "Read the source" ]] || fail "reload returns the saved node"
pass "reload returns the saved node"
[[ "$(jq -r '.nodes[0].position.x' <<<"$reloaded")" == "120" ]] || fail "reload preserves node position"
pass "reload preserves node position"
[[ "$(jq -r '.nodes[0].proposal.agentOwns[0]' <<<"$reloaded")" == "Write the draft from the research only" ]] \
  || fail "reload preserves what the agent owns"
pass "reload preserves what the agent owns"
[[ "$(jq -r '.nodes[0].proposal.youOwn[0]' <<<"$reloaded")" == "Set tone, length and audience" ]] \
  || fail "reload preserves what the human owns"
pass "reload preserves what the human owns"
[[ "$(jq -r '.nodes[0].setup[0].done' <<<"$reloaded")" == "true" ]] || fail "reload preserves setup progress"
pass "reload preserves setup progress"
[[ "$(jq -r '.nodes[0].readiness' <<<"$reloaded")" == "configured" ]] || fail "reload preserves readiness"
pass "reload preserves readiness"

echo
echo "Rejections"
expect_status "stale revision is rejected as a conflict" 409 \
  "$(status_of PUT "/api/workflows/${id}" "$edited")"
expect_status "dangling edge is rejected" 422 \
  "$(status_of PUT "/api/workflows/${id}" "$(jq '.revision = 2 | .edges = [{id:"e1",source:"nope",target:"gone",type:"requires",label:"",inferred:false}]' <<<"$created")")"
expect_status "unknown workflow is not found" 404 "$(status_of GET /api/workflows/missing)"
expect_status "execution route does not exist" 404 "$(status_of POST "/api/workflows/${id}/run" '{}')"
for claimed in tested operational; do
  expect_status "readiness \"${claimed}\" is refused without run evidence" 422 \
    "$(status_of PUT "/api/workflows/${id}" \
        "$(jq --arg r "$claimed" '.revision = 2 | .nodes[0].readiness = $r' <<<"$edited")")"
done
# Readiness derivation runs on a scratch workflow so the main one stays at
# revision 2 for the restart checks below.
scratch="$(curl -sS -X POST -H 'content-type: application/json' \
  -d '{"title":"Smoke readiness scratch"}' "${BASE}/api/workflows")"
scratch_id="$(jq -r .id <<<"$scratch")"
reopened="$(curl -sS -X PUT -H 'content-type: application/json' \
  -d "$(jq --argjson n "$(jq '.nodes' <<<"$edited")" \
        '.nodes = $n | .nodes[0].setup[0].done = false' <<<"$scratch")" \
  "${BASE}/api/workflows/${scratch_id}")"
[[ "$(jq -r '.nodes[0].readiness' <<<"$reopened")" == "not_configured" ]] \
  || fail "a configured claim with an unchecked setup task is corrected to not_configured"
pass "a configured claim with an unchecked setup task is corrected to not_configured"
retick="$(curl -sS -X PUT -H 'content-type: application/json' \
  -d "$(jq '.nodes[0].setup[0].done = true' <<<"$reopened")" \
  "${BASE}/api/workflows/${scratch_id}")"
[[ "$(jq -r '.nodes[0].readiness' <<<"$retick")" == "configured" ]] \
  || fail "re-checking the task derives configured"
pass "re-checking the task derives configured"
expect_status "a javascript: setup link is refused" 422 \
  "$(status_of PUT "/api/workflows/${id}" \
      "$(jq '.revision = 2 | .nodes[0].setup[0].link = "javascript:alert(1)"' <<<"$edited")")"
expect_status "non-JSON body is rejected" 415 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: text/plain' -d 'x' "${BASE}/api/workflows")"
expect_status "unlisted browser origin is refused" 403 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
      -H 'origin: https://evil.example' -d '{"title":"x"}' "${BASE}/api/workflows")"

echo
echo "Persistence across service restart"
docker restart "$CONTAINER" >/dev/null
for _ in $(seq 1 50); do
  if curl -sS -o /dev/null "${BASE}/api/health" 2>/dev/null; then break; fi
  sleep 0.2
done
after="$(curl -sS "${BASE}/api/workflows/${id}")"
[[ "$(jq -r .revision <<<"$after")" == "2" ]] || fail "revision survives restart"
pass "revision survives restart"
[[ "$(jq -r '.nodes[0].title' <<<"$after")" == "Read the source" ]] || fail "node survives restart"
pass "node survives restart"
[[ "$(jq -r '.nodes[0].instructions' <<<"$after")" == "Summarise the source document." ]] \
  || fail "node instructions survive restart as stored text"
pass "node instructions survive restart as stored text"

echo
echo "All smoke checks passed."
