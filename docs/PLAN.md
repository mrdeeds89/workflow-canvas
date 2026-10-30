# Beginning-of-project plan

## Outcomes
Dom can see and edit independent steps and arrows, understand conditions and ownership, and inspect source instructions without reading an entire skill at once. The first useful release is an editor, not an execution engine.

## Milestone 0 — project foundation
Create the standalone repository, requirements, architecture proposal, privacy boundaries, and new-chat handoff. Preserve private operator notes outside Git. No application scaffold or cloud account required at this stage.
Acceptance: documents exist; Git repository validates; private operator notes and data stay ignored.

## Milestone 1 — usable visual editor
Status: partial. Schema, validation, SQLite save/reload, a design-time HTTP API, and a first canvas exist and are tested. Still open: a card details panel, drawing labelled non-requires arrows, import/export routes, list/rename/delete, Compose packaging, and an automated browser suite.
Proposed stack, now in use for the slice above: TypeScript + React + React Flow frontend, a small TypeScript HTTP backend, and SQLite.
1. Define versioned graph schema and fixtures: workflow, node, edge, group, source reference.
2. Build canvas: create, move, select, edit, delete, connect; pan/zoom and fit view.
3. Node detail panel: title, description, type, owner, inputs/outputs, checklist, acceptance criteria.
4. Label arrows and distinguish dependency, data flow, conditional branch, and revision links.
5. Implement server-side CRUD and JSON import/export with validation, transactional saves, and revision conflict detection.
6. Package via Docker Compose with persistent data volume, health check, and documented private-access configuration.
7. Supply one generic research workflow and one explanatory skill example using synthetic, non-private content.
Acceptance:
- Browser test creates and edits nodes/edges and reloads the same graph.
- Layout and details survive application/container restart.
- Export/import round-trips with stable identifiers and schema version.
- Invalid JSON, dangling edges, unsupported versions, and stale save revisions are rejected clearly without corrupting existing data.
- Dependency cycles are rejected; explicitly typed revision links remain visually distinct and non-executable.
- User-controlled text cannot execute HTML/script; no API accepts shell commands.
- A clean Compose build runs on a clean host; health and persistence checks pass.
- No execution buttons pretend to run real agents; status is explicitly design-only.

## Milestone 2 — understand complex skills
Import Markdown as data, retain source version/hash and section references, preview a proposed graph before saving, and distinguish explicit instructions from inferred relationships. Manual curation is required; an optional model-assisted adapter can come later.
Add expandable/collapsible groups, search, and progressive detail. Validate source references and display stale-source warnings.
Acceptance: sample skill maps to navigable source sections; inferred branches visibly labelled; malicious instruction text is never executed; collapsing groups preserves edges and saved layout.

## Milestone 3 — collaborative agent edits
Structured proposals against a graph revision, change preview, explicit accept/reject, and audit history. No unrestricted file writes from graph content. Multi-user authentication and concurrent editing require a separate design before enabling.

## Milestone 4 — optional execution visibility
Read-only Hermes Kanban adapter first. Separate reusable definitions from run instances and observed task status. Reconcile failures/stale data visibly. Execution and approval gates require a separately authorized milestone; financial authority is never inferred from task completion.

## Before a finished product release
The source repository is public under the MIT license. That is a source snapshot, not a finished product release. Still required before other people should run this as a service: authentication before any non-loopback bind, Docker Compose packaging, a fresh-environment install test, a dependency-license review, upgrade/backup/restore docs, and the milestone 1 acceptance checks that are still open. Do not add execution, a deployment workflow, or a network bind without explicit approval.

## First implementation session
Start milestone 1 with schema/validation tests and a minimal end-to-end create → save → reload slice, then expand UI. Do not build all later milestones at once. Use independent review before calling the first milestone ready.
