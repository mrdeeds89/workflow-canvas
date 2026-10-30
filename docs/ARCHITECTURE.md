# Architecture proposal

Status: partially implemented. Schema 3, validation, SQLite persistence, the design-time HTTP API, the canvas, a card and arrow details panel, a workflow sidebar, a plain-text brief, Light / Dark / system themes, and a read-only Hermes job evidence panel exist. Docker Compose, authentication, import/export routes, and execution do not.

## Deployment
Browser client → application HTTP service → SQLite and persistent data volume.
Frontend is built and served with the application. Docker Compose is the intended portable distribution boundary and is not packaged yet. Keep host addresses and deployment secrets outside repository defaults.

## Graph model
Versioned WorkflowDefinition (schema 3): id, title, description, brief, revision, nodes, edges, groups, sourceReferences.

`brief` is one plain-text string for the whole workflow. It is not a parsed form. Suggested headings are a writing convention only.

A node is a card. It carries a stable id, position, one of six card types (task, agent, integration, approval, artifact, note), a human/agent/unassigned owner, instructions, a JSON `spec` stored as inert text, acceptance criteria, and inputs/outputs.

Two card fields carry the product's main idea. `proposal` splits the work into `agentOwns` and `youOwn`, so a reader can see who owns each step rather than inferring it. `setup` is the checklist of configuration a card must pass before the step is ready to hand off, each task carrying a label, a detail line, an optional http(s) reference link, and a done flag.

`readiness` is the card's lifecycle: proposed, not_configured, configured, tested, operational. Only the first three are reachable by editing. `tested` and `operational` report the outcome of a real run, so a design-only editor must refuse to assert them; the server rejects them rather than letting a drawing imply a qualification. `configured` is derived on the server, not set by hand: an approved card (`not_configured`/`configured`) is stored as `configured` exactly when every setup task is checked (vacuously, when it has none) and as `not_configured` otherwise. `proposed` is never promoted automatically, because approval is a human decision. The badge therefore cannot contradict its own checklist.

Edges have stable IDs, endpoints and type: requires, data, conditional or revision. Conditional edges carry human-readable labels initially, not executable expressions.

Stored documents are migrated forward on load, in memory only, and the row is rewritten only when the client saves. A migration never invents state it has no evidence for.
Groups preserve member identities. Source references include document identity, hash/version and section locator. Inferred elements carry an explicit provenance flag.

WorkflowRun is a future separate entity. Design checklist completion must never masquerade as a successful run or a qualification result.

## Storage and API
Validate on the server. Use SQLite transactions and optimistic revision checks. Reject oversized payloads, dangling references, duplicate IDs and unsupported schema versions. Enforce graph semantics per edge type rather than globally forbidding explanatory revision arrows. Export portable JSON without host-specific absolute paths or secrets. Choose migration/backup strategy before data becomes valuable.

Implemented routes: `GET /api/health`, `GET /api/library`, `POST /api/projects`, `PATCH /api/projects/:id`, `POST /api/workflows`, `GET` / `PUT` / `DELETE /api/workflows/:id`, `POST /api/workflows/:id/move`, and `POST /api/workflows/:id/duplicate`. There is no import, export, or execution route. Library membership and order live beside the document, so moving or reordering does not change a workflow revision.

## Hermes job evidence (read-only)

Contract and decisions: `docs/HERMES-INTEGRATION.md`. Hermes schedules and runs jobs. Canvas only observes.

- **Harness side.** `harness/hermes/workflow_canvas_exporter.py` is the forced command of a restricted SSH key, one key per Hermes profile. It answers only `snapshot <job_id>`, does not import Hermes, and creates or changes no file in the Hermes home. It prints an allowlisted observation and refuses unknown Hermes releases.
- **Server side.** `src/harness/config.ts` loads the private harness config (`WORKFLOW_CANVAS_HARNESS_CONFIG`). `src/harness/source.ts` pulls over `ssh` with a fixed, shell-free argument list, or reads fixture files for the examples. `src/harness/store.ts` keeps `harness_links` and `harness_observations` beside the workflow table. Links are not part of the document, never change its revision, and are dropped on workflow delete. A request names a harness and profile by label; it can never supply a host, user, key, path, or command.
- **Shared.** `src/harness/observation.ts` validates observations by copying allowlisted fields only, and derives what the panel says. That covers the whole-job result wording, freshness from the server clock, and the warning flags. The browser corrects its own clock with `serverNow`.
- **Browser.** `web/src/HarnessPanel.tsx` renders every observed value as text. A job result is never mapped onto cards, and `tested` / `operational` readiness stay refused.

## Security posture
Private single-user first, not Internet-ready. Verify request origins and rendering safety; private networking is not a substitute for validation. Never interpret imported text, labels, or expressions as code. No execution API in first milestones. Add authentication and authorization before remote/public or multi-user exposure. Cloudflare and Supabase are not needed for initial deployment.

## Workflow brief read contract

This is the read contract for a future assistant. It is not an integration. There is no agent route, no MCP tool, and no write-back in this increment.

- **Read.** `GET /api/workflows/:id` returns the workflow document. `brief` is the workflow-level plain-text note. A future assistant reads that field from that response, or from the same document the editor saves. Do not scrape the page.
- **Meaning.** Human-authored notes for people and for a later assistant. Inert data. Not instructions to this application. Not HTML. Not a shell command. Not authorization to run a tool, job, schedule, or trade.
- **Verbatim.** The server stores and returns the string exactly as saved, including whitespace and characters that look like markup or code. It does not trim, parse headings, or execute the text. The editor renders it as a text-box value, never as HTML.
- **Suggested headings** are a writing convention, not a schema: Purpose, Inputs required, Expected outputs, Success criteria, Limits, Open questions. Missing headings are allowed. The server does not split `brief` into those fields. An empty string means no brief has been written.
- **Older documents.** Schema 1 and 2 load as schema 3 with `brief` set to `""` when the stored value is missing or not text. That empty string is absence, not a generated template. The stored row is not rewritten until the client saves. A string already present is kept character for character.
- **Write.** `PUT /api/workflows/:id` uses the existing revision rule. The body includes `brief`. A non-string, or a brief over 20,000 characters, is `422` and does not change the stored row. A stale revision is `409` and does not change the stored brief.
- **Out of scope.** Agent suggestions, proposal diffs, card-level briefs, execution, and treating the brief as a job spec.

## UI
Canvas is the primary surface; details panel and source viewer are secondary. Pan/zoom, labelled arrows, distinct gate nodes, clear ownership and collapsible groups. Avoid reducing the product to Kanban columns. Editing a map and executing a workflow are separate actions and modes.
