#!/usr/bin/env bash
# Run on the project VM. No host port, live build or persistent database is used.
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE='node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd'
NAME="wc-browser-test-$$"
cleanup() { docker rm -f "$NAME" >/dev/null; }
trap cleanup EXIT
# The container only supplies the pinned Node runtime and browser system libraries.
docker run -d --name "$NAME" -e HOME=/tmp/browser-root \
  -e PLAYWRIGHT_BROWSERS_PATH=/tmp/browsers \
  -e npm_config_update_notifier=false \
  -v "$PWD":/work -w /work "$IMAGE" sleep 1200 >/dev/null
USER_ARGS=(--user "$(id -u):$(id -g)" -e HOME=/tmp/browser-user -e npm_config_cache=/tmp/npm-user)
docker exec "${USER_ARGS[@]}" "$NAME" npm ci --ignore-scripts --no-fund
# These packages are installed only inside this throwaway test container.
docker exec "$NAME" npx playwright install --with-deps chromium
docker exec "${USER_ARGS[@]}" "$NAME" sh -c 'npm audit && npm run typecheck && npm test && npm run test:browser'
