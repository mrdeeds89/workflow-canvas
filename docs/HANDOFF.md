# Handoff

## Current state

Workflow Canvas is a design-only editor. This document describes the committed product, not an uncommitted experiment.

What exists:

- Schema 3 graph model, validation, and in-memory migration from schema 1 and 2 in `src/graph/`. The stored row is rewritten only when the client saves. Schema 3 adds a workflow-level plain-text `brief`.
- SQLite create/save/reload via `node:sqlite` (experimental in Node 22.23.4). Stale revisions and invalid graphs do not change the stored row.
- Design-time HTTP API in `src/http/` on `node:http` only. Routes: `GET /api/health`, `GET /api/library`, `POST /api/projects`, `PATCH /api/projects/:id`, `POST /api/workflows`, `GET` / `PUT` / `DELETE /api/workflows/:id`, `POST /api/workflows/:id/move`, `POST /api/workflows/:id/duplicate`. No execution route, no import/export route, and no authentication.
- Canvas UI: React 19.3.1 and `@xyflow/react` 12.12.0, built by Vite 8.3.5 from `web/` into gitignored `dist/web`. The service serves that build for non-`/api` paths with `script-src 'self'`, `nosniff`, `no-referrer`, traversal refusal, and an `index.html` fallback. Without a build the service stays API-only.
- Exact-pinned dev dependencies and a committed lockfile. Install with `npm ci --ignore-scripts`. `"private": true` stays set so the package is not published to npm.
- A synthetic example in `examples/research-workflow.json`.

- Details panel (`web/src/DetailsPanel.tsx`), described below.

- Workflow sidebar with projects, ordering, move, rename, duplicate and delete, described below.
- Light, Dark, and Follow system themes. Light is the default. Theme choice does not change the stored graph.
- Chromium checks: `scripts/test-browser.sh` (theme) and `scripts/editor-browser.sh` (editor, including a throwaway restart). Not Firefox, WebKit, or mobile.

What does not exist in the committed tree: undo, JSON import/export routes, Docker Compose, an access token, skill import, and execution. A newly drawn arrow is always `requires`; kind and label are edited in the details panel.

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

Toolbar adds a card, opens the workflow brief, renames the workflow, and shows save state. Autosave is 600 ms after a change, one save in flight, server-derived readiness written back, `409` stops autosave, `422` shows the first issue. The browser runs the shared `validateWorkflow` before adding an arrow. IDs use `crypto.getRandomValues` because `randomUUID` is unavailable on plain-http pages.

Appearance: Light, Dark, or Follow system, in the theme section below. Light remains the default.

New cards are placed in the nearest free grid slot rather than on top of existing cards. Rough edge: backward `revision` arrows route awkwardly.

Historical, before the committed suites: a manual browser check of the first canvas covered add, drag, connect, refused loop, delete, reload, and persistence across a service restart. That check was not itself a suite. The committed suites are the theme and editor sections below.

## Details panel

Selecting exactly one card or one arrow opens a right-hand panel.

- Card: name, description, type, Approve / Move back to proposed, agent and you ownership lists, setup checklist with an optional note and link per check, delete. Edits re-derive readiness with the shared `deriveReadiness`, so the badge updates as checks are ticked.
- Arrow: kind (requires, data, conditional, revision, each with a hint), label, delete. A conditional arrow is never stored without a condition. A kind change runs the shared validator and is refused if it would create a dependency loop.
- A link is written to the card only once `isSafeLink` (exported from `validate.ts` and shared with the server) accepts it, so a half-typed URL never blocks saving.
- Delete/Backspace inside a panel field edits text; React Flow ignores the key in inputs.

Browser-verified against stored state: panel opens; rename persists; Backspace in a field does not delete the card; a "You own" line persists and shows on the card; ticking the last check makes an approved card `configured`, unticking returns `not_configured`, a `proposed` card stays `proposed` with every check ticked, approving a fully ticked card gives `configured`, and adding an open check gives `not_configured` with the card showing 2/3. Typecheck clean, 61 tests pass, build succeeds.

Historical, at the details-panel commit: the bad-link warning, the arrow panel, and delete from the panel had not been browser-verified. The later editor suite covers the bad-link warning, arrow kind and label, loop refusal, and delete from the card panel. Still not covered: deleting an arrow from the panel.

## Sidebar

Server: `src/graph/library.ts` (types shared with the browser, no Node imports) and new store methods in `store.ts`. A `projects` table plus `project_id`, `position`, `updated_at` columns on `workflows`, added in place by `upgradeWorkflowsTable`; existing workflows become Unfiled in creation order. Organisation lives beside the document, so moving or reordering never changes a revision. Routes: `GET /api/library`, `POST /api/projects`, `PATCH /api/projects/:id` (rename), `POST /api/workflows` accepts `projectId`, `POST /api/workflows/:id/move {projectId|null, index}` (returns the library), `POST /api/workflows/:id/duplicate`, `DELETE /api/workflows/:id`. New workflows and copies go to the top of their list / right after the original. Project titles are trimmed, 1–200 characters. No project delete or duplicate (not requested).

Browser: `web/src/Shell.tsx` (library state, address bar `?w=` with Back support, actions) and `web/src/Sidebar.tsx`. Sidebar folds away to a thin rail (remembered in localStorage). "+ New workflow" at the top; projects with a hover "+" (new workflow in that project) and rename (pencil or double-click); Unfiled last. Row ⋯ menu: Rename, Duplicate, Move to…, Delete… (browser confirm). Rows drag to reorder within a list or onto another list. The open editor is keyed by workflow id; switching saves pending edits first; renaming or duplicating the open workflow goes through the editor (`EditorHandle.rename` / `settle`) so its revision stays in step and the copy includes unsaved edits. A bare visit opens the first workflow, or creates one if there are none.

Historical, at the sidebar commit: typecheck clean, 70 Node tests passed (new `test/library.test.ts` covers ordering, move between lists, delete gap-closing, duplicate independence, upgrading a pre-projects database, and the HTTP routes including bad input), build succeeded, smoke passed. The preview database was backed up under gitignored `backups/` and then upgraded: its 6 existing workflows appeared as Unfiled. The sidebar UI had not been exercised in a browser then. The later editor suite covers create, rename, duplicate, delete, drag order, Move to, and collapse. Dragging a workflow onto another project is still not covered.

## Decisions still in force

The details panel and sidebar specified here are in the committed tree. "When built" below is the recorded decision, not a claim that they are still missing.

- Access, when it leaves loopback: a browser on a private network, protected by a simple access token, with a scoped allow-list of origins. Not built. Not a public service.
- `proposed` stays distinct from `not_configured`.
- `configured` is derived from the checklist, not set by hand.
- The first editing slice is draw and edit. List/rename/delete, import/export, and skill mapping were not day-one requirements. A later decision adds a sidebar, below.
- Sidebar, when built: the whole sidebar folds away. Individual projects do not collapse. Projects are folders created in this app, not linked to an external project list. Order inside a project is manual. Moving between projects is both drag-and-drop and a "Move to…" menu. Sidebar actions are rename of workflows and projects, delete of a workflow with a confirmation step, and duplicate of a workflow. Deleting or duplicating a whole project was not requested; ask before adding it.
- Build order: card details panel first, then the sidebar. The sidebar needs a project entity, a workflow list route, rename, delete, duplicate, and stored ordering, with tests, and existing workflows placed in an unfiled group.

## Decisions from Dom: deploy and triggers (2026-10-30)

Dom wants workflows to be deployable, started by an **event, a state change, or a schedule (cron)**.

- **First version is design-only.** Triggers are designed and saved on the workflow now; actually running them is a later, separate step. Nothing in this step executes anything.
- **Who does the work, when runs exist: chosen per card.** A card is either done by a Hermes agent (via Hermes tasks or scheduled jobs) or by a script/tool the canvas runs itself.
- **Safety rule for runs:** every Approval card pauses the run until Dom approves it. Independently of this rule, anything that places live trades or moves money still needs Dom's explicit authorization outside the canvas; a workflow run or a completed card is never that authorization.
- **Event triggers:** mainly a message to Dom or a bot (e.g. Telegram). Also wanted, as nice-to-haves: a webhook from an outside service, another workflow or Hermes task finishing, and a market or price condition.

Order recorded then: details-panel feedback, then the sidebar, then trigger design. The panel and sidebar are in the tree. Execution still needs its own plan and approval before any code runs workflows.

## Open questions

Defaults below stay in force unless changed.

1. An approved card with no setup tasks derives to `configured`. Default: yes.
2. `owner` stays, alongside `proposal`, because dropping it in a migration destroys data. Default: keep it.

## Verification

Run on the pinned image from the README: `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, and `npm run build`. `scripts/smoke-api.sh` is the running-service check; use another `SMOKE_PORT` if 8787 is taken. It must keep the published port on loopback.

Historical, for the public snapshot `76f0897`, on Node v22.23.4 in `node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd`: `npm ci --ignore-scripts` installed 48 packages from the unchanged lockfile and reported 0 vulnerabilities, typecheck passed, tests passed 61 / failed 0, and `npm run build` succeeded. `scripts/smoke-api.sh` was not re-run for later increments; do not treat the earlier smoke 26/26 figure as current.

GitHub Actions run https://github.com/mrdeeds89/workflow-canvas/actions/runs/41073172234 on the push of `76f0897bd4ae37700c9849a23aaef2899014a500` finished with conclusion success. The job "typecheck, test, build" passed checkout, Node 22.23.4 setup, `npm ci --ignore-scripts`, typecheck, test, and build. The workflow permission is contents read-only. It does not deploy. The run also printed non-failing notices: the pinned actions target Node.js 20 and were forced onto Node.js 24, and `ubuntu-latest` is scheduled to move to Ubuntu 26.

## Known gaps

- `node:sqlite` is experimental in Node 22 and pins the runtime to `engines`.
- No JSON import/export route. Milestone 1 still wants that round trip. List, rename, move, duplicate, and delete are in the sidebar API.
- No undo. A newly drawn arrow is always `requires`.
- No Docker Compose file and no access token. The smoke script runs an ad-hoc container and was not re-run for later increments.
- Browser suites are Chromium only. Not covered: Firefox, WebKit, mobile, dragging a workflow onto another project, and deleting an arrow from the panel.
- Rerun on the project VM: `bash scripts/test-browser.sh` and `bash scripts/editor-browser.sh`. Neither uses the preview build or its database.

## Workflow brief

Schema 3 field `brief` is one plain-text string on the workflow document. Suggested headings are a writing convention, not fields: Purpose, Inputs required, Expected outputs, Success criteria, Limits, Open questions. The editor opens one text box from **Workflow brief** in the toolbar (open by default). The placeholder and hint show those headings. The server stores and returns the string as written. It does not trim, parse headings, or execute the text. The editor renders it as a text-box value, never as HTML.

Schema 1 and 2 load in memory as schema 3 with `brief: ""` when the stored value is missing or not text. That empty string is absence, not a generated template. Migration does not insert the suggested headings. A string already stored is kept character for character. The stored row is not rewritten until the next save. A non-string brief, or one over 20,000 characters, is `422` and does not change the stored row. A stale revision is `409` and does not change the stored brief.

Read contract for a future assistant, with no integration built: `docs/ARCHITECTURE.md`, section "Workflow brief read contract". `GET /api/workflows/:id` returns `brief` as inert text. This increment does not execute, propose, or write on an agent's behalf. There is no agent route.

Verified on the project VM against an exact index export of this increment, not the mixed working tree. Image `node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd`. `npm ci --ignore-scripts` installed 53 packages and reported 0 vulnerabilities. Typecheck passed. Node tests **80 pass / 0 fail**, including eight in `test/brief.test.ts`. `npm run build` succeeded. The live preview on `127.0.0.1:8787` was not rebuilt or restarted.

Throwaway Chromium check, no published port, temporary database, built UI from that export: the text box showed the suggested headings as placeholder; the pointer landed in `textarea.brief__input` (`elementFromPoint`); Backspace in the box did not delete the note card; autosave reached "All changes saved"; `GET` returned the typed text exactly, including `<script>alert(1)</script>`, at revision 2, schema 3. Reload showed the same text. After the throwaway service was stopped, the same brief was still in the database. After that service was started again, the same URL and `GET` still returned that brief, revision 2, and the text box matched. That check is the brief increment's throwaway browser pass, not the later committed editor suite. At that increment, `docs/ROADMAP.md` was still untracked. The documentation reconciliation adds a sanitized roadmap. It is a plan, not an implementation claim.

## Theme increment — isolated snapshot verification

This section supersedes the earlier historical browser-suite gap.

Light / Dark / Follow system is presentation-only. Light remains the default even on a dark OS. The labelled Theme selector lives above the editor and remains available with the sidebar folded or while loading. `workflow-canvas.theme` stores only validated `light`, `dark`, or `system`; missing/invalid/unavailable storage falls back to Light. Blocked storage still permits an in-memory choice, and sidebar storage is also guarded so it cannot prevent rendering. Only Follow system subscribes to media-query changes, with cleanup when leaving that mode.

`web/src/tokens.css` is the shared palette for the shell, cards, panels, menus, forms, warning/error/success states, focus, React Flow controls/background/minimap, and SVG edge paths/markers. Dark uses the approved preview palette; Light retains the original appearance with darker small-text accents/muted text and stronger input borders. Edge kind names and inferred annotations are now visible even with an empty user label; stored edge labels/semantics are unchanged. Readiness labels, setup counts, check marks and line patterns remain non-color cues. Theme is applied before React's first render; an initially blank browser page before the module loads is not guaranteed flash-free. CSP was not weakened.

Historical theme-only snapshot, not a whole-tree count. Verification used the README-pinned Node image:

- Baseline before the theme work: typecheck and 70 Node tests passed. New helper tests failed before implementation, then passed; the first browser test failed on the missing theme attribute before the UI change.
- Theme-only export via `bash scripts/test-browser.sh`: `npm ci --ignore-scripts` installed 53 packages; audit 0 vulnerabilities; typecheck passed; **72 Node tests passed, 0 failed** (70 baseline tests plus two theme tests; unrelated brief and editor work excluded); isolated Vite build succeeded; **4 Chromium browser tests passed**.
- Browser coverage: all three choices, explicit Light default on dark OS, keyboard Tab/ArrowDown/Enter and focus outline, reload persistence, OS changes in system mode and no effect in explicit modes, collapsed sidebar, invalid and blocked storage, unchanged graph/revision after theme changes, menu keyboard focus, card/link errors, conditional arrow errors, real API-induced stale-revision warning, SVG marker/path color equality in both palettes, and no page errors.
- Contrast: axe color-contrast found **0 violations in eight scans** (menu, card, arrow, warning in both palettes). It also reported incomplete checks on clipped/scaled canvas content: this is not an accessibility certification. Fifteen explicit token pairs per palette additionally passed thresholds (text 4.5:1; edges/focus 3:1), including every card-kind accent. Exact ratios and axe incomplete nodes are retained in the JSON artifacts.
- Eight screenshots in ignored `test-results/theme/theme-{light,dark}-cards-edges-menus-details-warnings-contrast/`: `{light,dark}-menu-canvas.png`, `-details-warning.png`, `-arrow-warning.png`, `-conflict-warning.png`. The same directories contain `{light,dark}-contrast.json`. Screenshots inspected for the menu/canvas, details and warning layouts. Failure traces are retained only on failure.

Rerun **on the project VM** with `bash scripts/test-browser.sh`. This creates a throwaway container from the exact README image, installs pinned Playwright/Chromium plus its system dependencies inside that container, runs checks as the repository owner's UID, and removes the container. It publishes no port. Playwright starts its own API on container loopback with a temporary SQLite database and `dist/theme-test-web`, never `dist/web`; `reuseExistingServer` is false. The lightweight `npm run test:browser` entry point assumes browser dependencies are already installed. Test outputs are overwritten on rerun, so copy artifacts first if retaining evidence.

Limits: Chromium desktop only; no Firefox/WebKit/mobile/screen-reader/forced-colors certification, complete keyboard interaction audit, or pixel-baseline comparison. No theme schema/backend changes. Verification uses an exact theme-only index export on the project VM, not the mixed working tree. No live preview build, deployment or publication is part of this increment.


## Editor audit

Repeatable Chromium checks live in `test/editor-browser/editor.spec.mjs`. Rerun on the project VM with `bash scripts/editor-browser.sh`. That script builds into `dist/editor-browser`, starts a throwaway loopback service on `127.0.0.1:18788` with a temporary database, runs the suite, restarts that service, and checks the same database. It does not use `wc-preview` or its volume. The published port is asserted loopback-only. The container is removed on exit.

A failed save stays on screen until Retry, a later edit, or a successful leave. It is not retried in a loop, and a failed leave does not switch away, so a late write cannot race the next open. A rename that arrives while the workflow is still loading is kept, and that first load still paints the canvas. Switching waits for the write already in flight, including an edit that arrives during that write. Deleting the open workflow holds writes during the attempt and drops unsaved edits only after the delete succeeds, so a failed delete stays on that workflow and can still save. A refused browser-back switch can leave the address on the workflow that was not opened; that URL mismatch is a separate follow-up, not part of this delete fix.

Historical, for the failed-save commit `638634d`, on the pinned image `node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd`, Chromium from `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea`: typecheck passed, Node tests 80 pass / 0 fail. Browser suite: 17 passed, and the throwaway restart check passed. Two of those tests lock the review findings: a failed save does not switch away, and a rename during load still opens the canvas. Not covered: Firefox, WebKit, mobile, dragging a workflow onto another project, and deleting an arrow from the panel.

## Latest whole-tree check

Isolated `git archive` of `638634d` on 2026-10-30, same pinned Node image. Not a live preview build. Exported source hashes were unchanged after the run.

- `npm ci --ignore-scripts`: 53 packages added, 54 audited, 0 vulnerabilities.
- `npm run typecheck`: passed.
- `npm test`: 80 pass, 0 fail, 0 skipped.
- `npm run build`: succeeded (182 modules).
- `bash scripts/test-browser.sh`: 80 pass / 0 fail again, then 4 Chromium theme tests passed.
- `bash scripts/editor-browser.sh`: 17 passed, throwaway port was loopback-only, service answered after restart, 1 restart check passed.

This documentation commit does not change application code. Firefox, WebKit, mobile, dragging a workflow onto another project, and deleting an arrow from the panel remain uncovered. `scripts/smoke-api.sh` was not re-run.

## Failed delete

A delete that fails no longer retires the open editor. Writes are held only while that delete is in flight. Unsaved edits are dropped only after the delete succeeds, and only then does the shell select another workflow. A failed delete shows the error and stays on the same workflow. A later edit still saves, and switching or reloading keeps it.

The refused browser-back URL mismatch is unchanged.

Before the fix, on an isolated export of `d5c70f4` plus the new test only, that Chromium test failed: the error was visible, the workflow stayed open, and the later edit never reached "All changes saved". After the fix, same pinned Node image, isolated export, not the live preview: `npm ci --ignore-scripts` added 53 packages and reported 0 vulnerabilities; typecheck passed; Node tests 80 pass / 0 fail; `npm run build` succeeded (182 modules, inside the export). `bash scripts/editor-browser.sh`: 18 passed, throwaway port `127.0.0.1:18788` was loopback-only, the service answered after restart, and 1 restart check passed. Exported source hashes were unchanged. The theme suite was not re-run. `scripts/smoke-api.sh` was not re-run. The live preview was not rebuilt or restarted.

The roadmap again says the primary audience is Hermes users first, step 5 is a Read-only Hermes adapter, and the first mapped example is still an open choice: a read-only market observer with existing-output inspection and offline replay first, or a non-financial example. That does not choose the mapping example. The non-financial execution pilot is unchanged. No job name or private source is in the document.

## Next action

Hands-on feedback on the details panel, sidebar, and brief is still open. Then trigger design, saved and not run, then the access token and Compose hosting. The live preview still serves the previous `dist/web`; this commit does not rebuild or restart it. Do not add execution, skill import, a deployment workflow, or a non-loopback bind. Publishing the source is not a deployment. The refused browser-back URL mismatch remains a follow-up.
