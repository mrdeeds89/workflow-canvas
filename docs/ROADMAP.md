# Product direction and staged roadmap

## Confirmed direction

Follow-up to the full-buildout discussion:

- Primary audience: Hermes users first. Single-user installations first.
- Prefer self-hosting on personal infrastructure or a local device. No mandatory hosted account or cloud service.
- The harness performs the work. Canvas designs, explains, and displays evidence. Integration must not silently introduce a second executor.
- Review real workflow examples individually before any execution work. A plain-text workflow brief is in the editor. It is inert text, not a job spec.
- Testing must distinguish existing evidence, offline replay, and newly executing a job. Job names, host paths, and captured output stay out of this repository.
- Distribution remains a goal. Light, Dark, and Follow system themes are in the editor. Packaging, authentication, and a clean install are not.

## Proposed architecture (not implemented or finally approved)

Portable standalone core, Hermes-first adapter, optional Desktop presentation plugin. Keep workflow definitions and exports independent of harness-specific job identifiers. A Desktop plugin is a presentation/integration option, not the canonical data store. Evaluate MCP as an agent-facing proposal/read interface, not as a scheduler or an automatic guarantee of cross-harness execution.

The harness owns scheduling and execution. Canvas retains versioned definitions and separate run/evidence records. Do not create duplicate schedules when linking existing jobs. Credentials stay with the owning harness. That does not remove the need for authorization on a bridge capable of starting work.

Supersedes the earlier proposed Canvas-native script executor as the default direction. The exact adapter contract still needs design and review.

## Ordered steps and acceptance

1. **Workflow brief and existing editor verification.** Done in the committed editor: one plain-text workflow brief, card and arrow details, and Chromium checks for the sidebar and details panel. Acceptance already recorded for the brief: it survives reload and a throwaway restart, renders as inert text, and is available through the read contract in `docs/ARCHITECTURE.md`. No executor. Hands-on review of that editor is still open. Do not build a workflow example until that review happens.
2. **One real scheduled job as a reviewed map.** Start with a read-only observer candidate. Inspect its launcher, source, and output only under a separate approval. Map guards and failure paths, retain source provenance, and label inferred edges. Keep private evidence out of public examples. Acceptance: each card is reviewed against what the job actually does; captured, skipped, failed, and blocked stay distinct, and none implies a trade.
3. **Evidence-only pilot.** Import a recorded run into separate evidence, then replay copied fixtures offline (normal, missing data, stale data, error, and skip). No production writes or delivery. Acceptance: each displayed result traces to evidence; no invented per-step timing, approval, or successful gates. A fresh execution is a separately scoped follow-up, not permission to resume paused jobs.
4. **Daily usability and local packaging.** Theme choice is in the editor. Still open: undo, validated import/export, backup/restore, authentication, and pinned Compose packaging. Acceptance: browser tests, a clean install, and a restore/restart test on personal infrastructure; no mandatory cloud dependency and no public exposure. The existing Chromium suites do not replace that install test. A packaging proposal, not an approval to build it, is in `.hermes/plans/2026-10-30_193740-personal-self-hosting.md`.
5. **Read-only Hermes adapter.** Link existing jobs and show schedule, state, and latest evidence with freshness and disconnected states. Acceptance: no schedule cloning, bounded permissions, no secrets in exports, stale observations clearly labelled. Contract and decisions: `docs/HERMES-INTEGRATION.md`. A read-only prototype is built and tested against fixtures. It is not installed on any harness; see `docs/HANDOFF.md`.
6. **Agent-assisted editing.** Revision-bound change proposals, diff/accept/reject, source-linked skill imports. Decide MCP versus native tools through a small prototype and official interface verification. Acceptance: conflicts cannot overwrite edits, and imported text cannot execute tools.
7. **Explicitly approved execution pilot.** Design the trigger and dispatch contract, approval enforcement, cancellation, retries, idempotency, and recovery before activation. Start with one non-financial local-output workflow. Acceptance: the harness enforces gates, duplicate triggers do not duplicate work, and restart recovery and failure states are tested. No live-money authority is inferred.
8. **Distribution.** Versioned releases, migration and rollback documentation, sanitized templates, fresh-install testing, an optional plugin, and later harness adapters. Publishing artifacts or catalog entries requires explicit approval.

## Decisions recorded for the brief increment (2026-10-30)

Implemented in commit `638403b`. This is not an uncommitted working tree.

- One free-text workflow brief, not separate purpose/input/output fields.
- Suggested headings, shown in the editor and not required or parsed: Purpose, Inputs required, Expected outputs, Success criteria, Limits, Open questions.
- Human text is stored verbatim. A future agent may read `brief` from `GET /api/workflows/:id` under the read contract in `docs/ARCHITECTURE.md`. No agent integration and no execution in this increment.
- Stop for review of that editor before any workflow example is built.

## Open decisions before the next UI change

- Prefer a single free-text workflow brief with suggested headings, or separate purpose/input/output fields? **Decided and implemented 2026-10-30: the single text box.** The question stays here so the choice remains visible.
- First source-reviewed example: a read-only market observer with existing-output inspection and offline replay first, or a non-financial example? Do not put job names, host paths, or captured output in this repository.

## Verification status

This document is a plan, not an implementation claim. What is built, and the historical check counts, are in `docs/HANDOFF.md`. No schedules were changed or fired while preparing this roadmap. Job names, host paths, credentials, and captured private output are omitted on purpose.
