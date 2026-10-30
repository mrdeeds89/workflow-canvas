# Workflow Canvas

A standalone visual workspace for designing workflows as cards and arrows: who owns each step, and which checks must pass before handing off.

**Status:** design-only editor. Schema validation, SQLite save/reload, a loopback HTTP API, and a canvas UI exist and are tested. There is no authentication, no execution, and no deployment package.

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 DomP.

## What you can do

- Add any of six card types: task, agent, integration, approval, artifact, note. New cards start as `proposed`.
- See type, a readiness pill, agent/you ownership columns, and setup progress `n/m` on each card.
- Drag cards, draw a `requires` arrow from the right handle to the left handle, and delete the selection with Delete or Backspace.
- Rename the workflow from the toolbar. A bare visit creates a workflow and puts `?w=<id>` in the address; that URL is how you return.
- Autosave about 600 ms after a change. The server derives `configured` / `not_configured` and writes that back onto the cards.
- Dependency cycles are refused before they are drawn. A conflicting save (`409`) stops autosave and asks for a reload.

`examples/research-workflow.json` is synthetic sample content. `scripts/seed-example.sh [base-url]` loads it into a running service (default `http://127.0.0.1:8787`).

## What is not built

- A details panel to edit a card's title, description, ownership, setup checklist, or approval.
- Drawing or editing arrow kinds other than `requires`, or editing an arrow label. Undo.
- A workflow list, projects sidebar, rename/delete of saved workflows, or JSON import/export routes.
- Docker Compose packaging, authentication, skill import, execution, and automated browser tests.
- `tested` and `operational` readiness. Those report a real run. This editor cannot assert them.

## Safety

This is not an execution engine. Checking a box or drawing an arrow never runs a tool, sends a trade, or authorizes an agent.

The service has **no authentication**. It binds to `127.0.0.1` unless `WORKFLOW_CANVAS_HOST` is set. Do not publish the port, put it behind a public proxy, or bind it to a reachable interface until a later access control exists. With the default empty `WORKFLOW_CANVAS_ALLOWED_ORIGINS`, browser cross-origin API calls are denied.

`package.json` is `"private": true`. Do not publish this package to npm.

Do not commit credentials, databases, generated builds, import dumps, or private operator notes.

## Local setup

Node.js **22.23.4**. Local install, typecheck, test, and build use this pinned image:

`node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd`

From a checkout of this repository:

```bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e npm_config_update_notifier=false \
  -v "$PWD":/work -w /work \
  node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd \
  sh -c "npm ci --ignore-scripts && npm run typecheck && npm test && npm run build"
```

Run the service on loopback after that build:

```bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD":/work -w /work \
  -v canvas-data:/work/data \
  -p 127.0.0.1:8787:8787 \
  -e WORKFLOW_CANVAS_HOST=0.0.0.0 \
  -e WORKFLOW_CANVAS_PORT=8787 \
  -e WORKFLOW_CANVAS_DB=/work/data/canvas.sqlite \
  node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd \
  node --experimental-strip-types --disable-warning=ExperimentalWarning src/http/main.ts
```

The process inside the container listens on all of its own interfaces so the published port works. The publish is `127.0.0.1:8787` only. Open `http://127.0.0.1:8787`.

`scripts/smoke-api.sh` starts a throwaway container, checks loopback-only exposure, restarts it, and removes it. Set `SMOKE_PORT` if 8787 is already in use. It needs Docker, curl, and jq.

### Configuration

| Variable | Default | Role |
|---|---|---|
| `WORKFLOW_CANVAS_HOST` | `127.0.0.1` | Bind address. Leave the default. |
| `WORKFLOW_CANVAS_PORT` | `8787` | Listen port. |
| `WORKFLOW_CANVAS_DB` | `data/canvas.sqlite` | SQLite file. Ignored by Git. |
| `WORKFLOW_CANVAS_ALLOWED_ORIGINS` | empty (deny browser origins) | Comma-separated exact origins. |
| `WORKFLOW_CANVAS_STATIC` | `dist/web` | Built UI. Without `index.html` the service stays API-only. |

API routes: `GET /api/health`, `POST /api/workflows`, `GET /api/workflows/:id`, `PUT /api/workflows/:id`. No execution route. A save sends back the revision it loaded; the server stores the next revision and returns `409` on a stale write.

## Checks

GitHub Actions runs `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, and `npm run build` on Node 22.23.4. That workflow is read-only: it does not deploy and it has no secrets.

Typecheck is `tsc` with `noEmit`, `strict`, and `noUncheckedIndexedAccess`. The UI project uses DOM types only, so shared graph code imported by the browser cannot use Node globals. Tests are `node --test` over `test/*.test.ts`.

## Docs

- `docs/PLAN.md` — milestones and acceptance checks.
- `docs/ARCHITECTURE.md` — graph model, storage, and security posture.
- `docs/HANDOFF.md` — current state and the next build step.
- `AGENTS.md` — safety and engineering rules.
