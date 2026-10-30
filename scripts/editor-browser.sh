#!/usr/bin/env bash
# Repeatable browser audit of the design-only editor.
#
# Builds the current UI into dist/editor-browser (never dist/web, which the
# preview container serves), starts a throwaway loopback service with a
# throwaway database, runs the Playwright suite, restarts that service, and
# checks the same database again. Does not touch wc-preview or its volume.
#
# Run on the project VM from the repository root. Requires Docker.
# Usage: scripts/editor-browser.sh

set -euo pipefail

NODE_IMAGE="node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd"
PW_IMAGE="mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea"
CONTAINER="wc-editor-browser"
PORT="${EDITOR_BROWSER_PORT:-18788}"
BASE="http://127.0.0.1:${PORT}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$(mktemp -d)"
UID_GID="$(id -u):$(id -g)"

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; exit 1; }

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

if [[ "$PORT" == "8787" || "$PORT" == "18787" ]]; then
  fail "refusing port ${PORT}; it belongs to another service"
fi
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
  if ! ss -ltn | grep -qE ":${PORT}\\b"; then break; fi
  sleep 0.1
done
if ss -ltn | grep -qE ":${PORT}\\b"; then
  fail "port ${PORT} is already in use"
fi

echo "Building UI into dist/editor-browser (preview dist/web is left alone)"
docker run --rm --user "$UID_GID" -e HOME=/tmp \
  -e npm_config_update_notifier=false \
  -v "${REPO}:/work" -w /work \
  "$NODE_IMAGE" \
  npx vite build --outDir ../dist/editor-browser --emptyOutDir

echo "Starting throwaway editor on 127.0.0.1:${PORT}"
docker run -d --name "$CONTAINER" --user "$UID_GID" -e HOME=/tmp \
  -v "${REPO}:/work:ro" \
  -v "${DATA_DIR}:/data" \
  -w /work \
  -p "127.0.0.1:${PORT}:8787" \
  -e WORKFLOW_CANVAS_HOST=0.0.0.0 \
  -e WORKFLOW_CANVAS_PORT=8787 \
  -e WORKFLOW_CANVAS_DB=/data/canvas.sqlite \
  -e WORKFLOW_CANVAS_ALLOWED_ORIGINS="${BASE}" \
  -e WORKFLOW_CANVAS_STATIC=/work/dist/editor-browser \
  -e WORKFLOW_CANVAS_HARNESS_CONFIG=/work/test/fixtures/harness/browser-config.json \
  "$NODE_IMAGE" \
  node --experimental-strip-types --disable-warning=ExperimentalWarning src/http/main.ts >/dev/null

for _ in $(seq 1 50); do
  if curl -sf -o /dev/null "${BASE}/api/health"; then break; fi
  sleep 0.2
done
curl -sf -o /dev/null "${BASE}/api/health" || fail "editor did not become healthy"

listeners="$(ss -ltn "sport = :${PORT}" | tail -n +2)"
if grep -qE "(0\\.0\\.0\\.0|\\*|\\[::\\]):${PORT}" <<<"$listeners"; then
  fail "port ${PORT} is published beyond loopback: ${listeners}"
fi
grep -q "127.0.0.1:${PORT}" <<<"$listeners" || fail "expected a loopback listener on ${PORT}"
pass "port ${PORT} is published on loopback only"

run_pw() {
  docker run --rm --network host --user "$UID_GID" -e HOME=/tmp \
    -e WC_BASE_URL="${BASE}" \
    -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    -v "${REPO}:/work" -w /work \
    "$PW_IMAGE" \
    npx playwright test -c playwright.editor.config.mjs "$@"
}

echo
echo "Browser suite"
run_pw --grep-invert @restart

echo
echo "Restarting the throwaway service on the same database"
docker restart "$CONTAINER" >/dev/null
for _ in $(seq 1 50); do
  if curl -sf -o /dev/null "${BASE}/api/health"; then break; fi
  sleep 0.2
done
curl -sf -o /dev/null "${BASE}/api/health" || fail "editor did not return after restart"
pass "service answered after restart"

echo
echo "Browser check after restart"
run_pw --grep @restart

echo
echo "Editor browser audit passed"
