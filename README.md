# Workflow Canvas

A standalone visual workspace for designing workflows as cards and arrows: who owns each step, and which checks must pass before handing off.

**Status:** design-only editor. Schema validation, SQLite save/reload, a loopback HTTP API, a canvas, a card and arrow details panel, a project sidebar, a workflow brief, Light / Dark / system themes, a read-only Hermes job evidence panel, and a "What would run" check with run requests that are recorded but never executed exist and are tested. There is no authentication, no execution, and no deployment package.

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 DomP.

## What you can do

- Add any of six card types: task, agent, integration, approval, artifact, note. New cards start as `proposed`.
- See type, a readiness pill, agent/you ownership columns, and setup progress `n/m` on each card.
- Drag cards, draw a `requires` arrow from the right handle to the left handle, and delete the selection with Delete or Backspace.
- Open one card to edit its name, description, type, approval, agent/you ownership, and setup checklist. Open one arrow to change its kind and label. A newly drawn arrow is always `requires`. A conditional arrow is not stored without a label.
- Write a workflow brief from the toolbar: one plain-text box. Suggested headings are Purpose, Inputs required, Expected outputs, Success criteria, Limits, and Open questions. The text is saved as written and never runs anything.
- Rename the workflow from the toolbar or the sidebar. A bare visit opens the first workflow, or creates one, and puts `?w=<id>` in the address.
- List workflows in a sidebar: projects, manual order, move, rename, duplicate, and delete with confirmation. Folding the sidebar does not change the graph.
- Link a workflow to an existing Hermes cron job and see, read-only: its schedule, enabled/paused state, next and last run, the latest **whole-job** result, recent attempts, where the observation came from, and how old it is. Warnings cover stale or disconnected data, a job that is missing, an unsupported Hermes version, a silent scheduler, an overdue job, and a job whose definition changed since linking. Nothing on the panel can run, pause, resume, or edit the job, and a job result never changes a card. Three synthetic example jobs ship in `examples/hermes-observations/`, so the panel works without Hermes. See `docs/HERMES-INTEGRATION.md` and `harness/hermes/README.md`.
- Say who would do each task, agent, or integration card if it ever runs: a Hermes profile, skills to load, and a time limit per attempt. These are names only.
- Open **What would run** to check the workflow against the run rules in `docs/RUN-PLAN.md`. It lists what blocks a run (a proposed or unfinished card, an Inferred label, no profile, a bad branch, a loop), each message opening its card, and shows the stages: approval cards and branch choices split the run. **Request run** records a request for the saved revision. No conductor exists yet, so nothing runs, and a request expires after 15 minutes so a conductor added later cannot act on an old click.
- Confirm a card or arrow that an agent drew (labelled Inferred). A run will not use it until you do.
- Choose Light, Dark, or Follow system. Light is the default, including on a dark OS. The choice is presentation only and does not change the saved workflow.
- Autosave about 600 ms after a change. The server derives `configured` / `not_configured` and writes that back onto the cards.
- Dependency cycles are refused before they are drawn. A conflicting save (`409`) stops autosave and asks for a reload. A failed save stays on the open workflow until Retry, another edit, or a successful leave.

`examples/research-workflow.json` is synthetic sample content. `scripts/seed-example.sh [base-url]` loads it into a running service (default `http://127.0.0.1:8787`).

## What is not built

- Undo.
- Drawing a new arrow as anything other than `requires`. Kind and label are edited after the arrow exists.
- JSON import/export routes.
- Docker Compose packaging, authentication, skill import, and execution.
- Installing the Hermes exporter on a harness. It is a manual, documented step (`harness/hermes/README.md`), and nothing in this repository does it.
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

`scripts/smoke-api.sh` starts a throwaway container, checks loopback-only exposure, restarts it, and removes it. Set `SMOKE_PORT` if 8787 is already in use. It needs Docker, curl, and jq. It was not re-run for the later editor increments; do not treat an older smoke count as current.

### Configuration

| Variable | Default | Role |
|---|---|---|
| `WORKFLOW_CANVAS_HOST` | `127.0.0.1` | Bind address. Leave the default. |
| `WORKFLOW_CANVAS_PORT` | `8787` | Listen port. |
| `WORKFLOW_CANVAS_DB` | `data/canvas.sqlite` | SQLite file. Ignored by Git. |
| `WORKFLOW_CANVAS_ALLOWED_ORIGINS` | empty (deny browser origins) | Comma-separated exact origins. |
| `WORKFLOW_CANVAS_STATIC` | `dist/web` | Built UI. Without `index.html` the service stays API-only. |
| `WORKFLOW_CANVAS_HARNESS_CONFIG` | unset (no harnesses) | Private JSON file naming the Hermes harnesses this server may observe. Keep it outside the repository. Try the public examples with `examples/hermes-observations/harness-config.example.json`. |

API routes:

- `GET /api/health`
- `GET /api/library`
- `POST /api/projects`, `PATCH /api/projects/:id` (rename)
- `POST /api/workflows` (optional `projectId`)
- `GET`, `PUT`, and `DELETE /api/workflows/:id`
- `POST /api/workflows/:id/move`, `POST /api/workflows/:id/duplicate`
- `GET` / `POST /api/workflows/:id/runs`, `GET /api/workflows/:id/runs/:runId`, `POST /api/workflows/:id/runs/:runId/cancel` (run requests: records only, see `docs/RUN-PLAN.md`)
- `GET /api/harnesses` (labels and profiles only), `GET /api/workflows/:id/harness`, `PUT` / `DELETE /api/workflows/:id/harness-link`, `POST /api/workflows/:id/harness-link/refresh` (pulls a read-only observation, rate-limited)

No execution route and no agent route. A run request is a record; nothing in Canvas acts on it. No route creates, edits, pauses, resumes, runs, or deletes a Hermes job. Linking and refreshing never change a workflow's revision. A document save sends the revision it loaded; the server stores the next revision and returns `409` on a stale write. Moving or reordering a workflow does not change that revision. The document field `brief` is plain text, stored and returned verbatim. The read contract for a future assistant is in `docs/ARCHITECTURE.md`.

## Checks

GitHub Actions runs `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, and `npm run build` on Node 22.23.4. That workflow is read-only: it does not deploy, it does not run the browser suites, and it has no secrets.

Typecheck is `tsc` with `noEmit`, `strict`, and `noUncheckedIndexedAccess`. The UI project uses DOM types only, so shared graph code imported by the browser cannot use Node globals. Tests are `node --test` over `test/*.test.ts`.

Local browser checks, on a machine with Docker, do not use a running preview's build or database:

- `bash scripts/test-browser.sh` — theme suite. No host port.
- `bash scripts/editor-browser.sh` — editor suite, then a throwaway restart. Default host port `127.0.0.1:18788`. It refuses `8787` and `18787`.

## Docs

- `docs/PLAN.md` — milestones and acceptance checks.
- `docs/ARCHITECTURE.md` — graph model, storage, and security posture.
- `docs/HANDOFF.md` — current state, historical check counts, and the next build step.
- `docs/ROADMAP.md` — product direction. Later steps are not built.
- `AGENTS.md` — safety and engineering rules.
