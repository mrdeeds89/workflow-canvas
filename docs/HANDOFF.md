# Handoff

## Current state

Workflow Canvas is a design-only editor. This document describes the committed product, not an uncommitted experiment.

What exists:

- Schema 2 graph model, validation, and in-memory migration from schema 1 in `src/graph/`. The stored row is rewritten only when the client saves.
- SQLite create/save/reload via `node:sqlite` (experimental in Node 22.23.4). Stale revisions and invalid graphs do not change the stored row.
- Design-time HTTP API in `src/http/` on `node:http` only: `GET /api/health`, `POST /api/workflows`, `GET /api/workflows/:id`, `PUT /api/workflows/:id`. No execution route and no authentication.
- Canvas UI: React 19.3.1 and `@xyflow/react` 12.12.0, built by Vite 8.3.5 from `web/` into gitignored `dist/web`. The service serves that build for non-`/api` paths with `script-src 'self'`, `nosniff`, `no-referrer`, traversal refusal, and an `index.html` fallback. Without a build the service stays API-only.
- Exact-pinned dev dependencies and a committed lockfile. Install with `npm ci --ignore-scripts`. `"private": true` stays set so the package is not published to npm.
- A synthetic example in `examples/research-workflow.json`.

- Details panel (`web/src/DetailsPanel.tsx`), described below.

What does not exist in the committed tree: undo, a workflow list or projects sidebar, delete, JSON import/export routes, Docker Compose, an access token, skill import, execution, and an automated browser suite.

Public source: https://github.com/mrdeeds89/workflow-canvas under the MIT license. Publishing this repository does not deploy the service. The application stays loopback-only. History from before this public snapshot stays only in a private backup. It is not an ancestor of these commits and must not be pushed.

## Card model

Six card types: `task`, `agent`, `integration`, `approval`, `artifact`, `note`. The earlier `gate` type became `approval`.

- `proposal: { agentOwns[], youOwn[] }` is an ownership split, not a single enum. `owner` remains the step's primary responsibility and is kept so a migration does not destroy it.
- `setup: SetupTask[]` is the handoff checklist. Each task has `text`, `detail`, an optional `link`, and `done`. Links must be empty or http(s). `javascript:`, `data:`, and `file:` are rejected as `unsafe_link`.
- `readiness`: `proposed | not_configured | configured | tested | operational`.
- `spec` is free-form JSON text, stored verbatim and never interpreted.

Priorities for the card: the step is visible, who owns it is visible, and the checks it must pass before handing off are visible.

## Readiness boundary

`tested` and `operational` report a real run. The server rejects them with `readiness_requires_run_evidence`. A drawing cannot imply a qualification.

`configured` is derived (`deriveReadiness` in `src/graph/types.ts`). An approved card is stored as `configured` when every setup task is checked, including when it has none, and as `not_configured` otherwise. A stale `configured` claim is corrected rather than rejected. `proposed` is never promoted automatically; approval stays a human action. The badge cannot contradict its own checklist.

Validation also rejects unsupported versions, dangling edges, duplicate ids, incomplete nodes, unlabelled conditional edges, and `requires` cycles. Revision-link cycles are allowed. User text is stored as data. Unknown fields such as `runCommand` are dropped.

## Revision contract

`GET` returns revision N. The client `PUT`s that same document, still carrying N. The server treats N as the expected revision, stores N+1, and returns the new document. A second `PUT` of N gets `409`. Body `id` must match the path `id` or the request gets `400`.

Other statuses: `422` invalid graph (with issues), `415` non-JSON, `413` body over 1 MB, `403` unlisted browser `Origin`, `405` with `Allow`, `404` unknown workflow or route.

## Configuration

`WORKFLOW_CANVAS_HOST` (default `127.0.0.1`), `WORKFLOW_CANVAS_PORT` (default `8787`), `WORKFLOW_CANVAS_DB` (default `data/canvas.sqlite`), `WORKFLOW_CANVAS_ALLOWED_ORIGINS` (comma-separated, default empty = deny every browser origin), `WORKFLOW_CANVAS_STATIC` (default `dist/web`). No authentication, so the bind stays on loopback until a token check exists on every API route.

## Canvas behaviour

Toolbar adds a card, renames the workflow, and shows save state. Autosave is 600 ms after a change, one save in flight, server-derived readiness written back, `409` stops autosave, `422` shows the first issue. The browser runs the shared `validateWorkflow` before adding an arrow. IDs use `crypto.getRandomValues` because `randomUUID` is unavailable on plain-http pages.

Chosen look: light theme and the current card design.

New cards are placed in the nearest free grid slot rather than on top of existing cards. Rough edge: backward `revision` arrows route awkwardly.

A browser check of the first canvas covered add, drag, connect, refused loop, delete, reload, and persistence across a service restart. That check is not an automated suite in this repository.

## Details panel

Selecting exactly one card or one arrow opens a right-hand panel.

- Card: name, description, type, Approve / Move back to proposed, agent and you ownership lists, setup checklist with an optional note and link per check, delete. Edits re-derive readiness with the shared `deriveReadiness`, so the badge updates as checks are ticked.
- Arrow: kind (requires, data, conditional, revision, each with a hint), label, delete. A conditional arrow is never stored without a condition. A kind change runs the shared validator and is refused if it would create a dependency loop.
- A link is written to the card only once `isSafeLink` (exported from `validate.ts` and shared with the server) accepts it, so a half-typed URL never blocks saving.
- Delete/Backspace inside a panel field edits text; React Flow ignores the key in inputs.

Browser-verified against stored state: panel opens; rename persists; Backspace in a field does not delete the card; a "You own" line persists and shows on the card; ticking the last check makes an approved card `configured`, unticking returns `not_configured`, a `proposed` card stays `proposed` with every check ticked, approving a fully ticked card gives `configured`, and adding an open check gives `not_configured` with the card showing 2/3. Typecheck clean, 61 tests pass, build succeeds.

Not yet verified: the bad-link warning, the arrow panel (kind, label, loop refusal), and delete from the panel. The agent's browser tool proved unreliable for this (calls alternated between two browsers), so Dom is testing hands-on; an automated browser suite on the VM would make agent verification independent of that tool.

## Decisions still in force

- Access, when it leaves loopback: a browser on a private network, protected by a simple access token, with a scoped allow-list of origins. Not built. Not a public service.
- `proposed` stays distinct from `not_configured`.
- `configured` is derived from the checklist, not set by hand.
- The first editing slice is draw and edit. List/rename/delete, import/export, and skill mapping were not day-one requirements. A later decision adds a sidebar, below.
- Sidebar, when built: the whole sidebar folds away. Individual projects do not collapse. Projects are folders created in this app, not linked to an external project list. Order inside a project is manual. Moving between projects is both drag-and-drop and a "Move to…" menu. Sidebar actions are rename of workflows and projects, delete of a workflow with a confirmation step, and duplicate of a workflow. Deleting or duplicating a whole project was not requested; ask before adding it.
- Build order: card details panel first, then the sidebar. The sidebar needs a project entity, a workflow list route, rename, delete, duplicate, and stored ordering, with tests, and existing workflows placed in an unfiled group.

## Open questions

Defaults below stay in force unless changed.

1. An approved card with no setup tasks derives to `configured`. Default: yes.
2. `owner` stays, alongside `proposal`, because dropping it in a migration destroys data. Default: keep it.

## Verification

Run on the pinned image from the README: `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, and `npm run build`. `scripts/smoke-api.sh` is the running-service check; use another `SMOKE_PORT` if 8787 is taken. It must keep the published port on loopback.

Checked for this snapshot on Node v22.23.4 in `node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd`: `npm ci --ignore-scripts` installed 48 packages from the unchanged lockfile and reported 0 vulnerabilities, typecheck passed, tests passed 61 / failed 0, and `npm run build` succeeded. `scripts/smoke-api.sh` was not re-run; do not treat the earlier smoke 26/26 figure as current.

GitHub Actions run https://github.com/mrdeeds89/workflow-canvas/actions/runs/41073172234 on the push of `76f0897bd4ae37700c9849a23aaef2899014a500` finished with conclusion success. The job "typecheck, test, build" passed checkout, Node 22.23.4 setup, `npm ci --ignore-scripts`, typecheck, test, and build. The workflow permission is contents read-only. It does not deploy. The run also printed non-failing notices: the pinned actions target Node.js 20 and were forced onto Node.js 24, and `ubuntu-latest` is scheduled to move to Ubuntu 26.

## Known gaps

- `node:sqlite` is experimental in Node 22 and pins the runtime to `engines`.
- No list, delete, or JSON import/export route. Milestone 1 still wants import/export. Workflow delete in the sidebar decision is not built.
- No Docker Compose file. The smoke script runs an ad-hoc container.
- No automated browser test in the repo.

## Next action

Collect Dom's hands-on feedback on the details panel and finish its unverified checks. Then build the sidebar described above. Do not add execution, skill import, a deployment workflow, or a non-loopback bind.
