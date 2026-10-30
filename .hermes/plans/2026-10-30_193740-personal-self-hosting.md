# Personal Self-Hosting Implementation Plan

> **For Hermes:** Use the subagent-driven-development skill to implement this plan task-by-task if available; otherwise use small independently reviewed increments. This document is a proposal, not authorization to implement, deploy, commit, or publish.

**Goal:** Let an individual run Workflow Canvas on their own computer or private server without mandatory cloud accounts, with portable workflow definitions and recoverable installation data.

**Architecture:** Keep the standalone browser → Node HTTP service → SQLite design. Separate workflow interchange from full installation recovery; add local single-user authentication before packaging private access. Keep execution disabled and leave the existing installation untouched until a separately approved cutover.

**Tech Stack:** Existing TypeScript, React, React Flow, Vite, node:http, node:sqlite, Node tests, Playwright; proposed Docker Compose distribution with digest-pinned build/runtime images and named storage. No hosted identity provider, hosted database, mandatory Hermes connection, cloud telemetry, or registry publication.

---

## Scope and approval boundaries

This turn is planning only. Only this plan file is added. No dependency installation, application change, build, test server, container creation, restart, migration, image publication, Git commit/push, tunnel, proxy, or infrastructure activation is authorized by this plan.

Before implementation, approve the slices and the isolated test scope. Tests that start services need explicit approval too, even when they use loopback. Before deployment, separately approve the exact cutover and access scope. Remote/private access, a new host listener, any public endpoint, image publication, and Git publication are distinct decisions, not consequences of accepting the plan.

Read-only inspection used the canonical VM tree through the verified SSHFS mount and SSH. Private connection details remain in ignored `INFRA.md`, not in these instructions or public examples. Its historical teardown snippets are not application rollback procedures and must not be run for this work.

Preserve the existing dirty working tree, including brief/schema-3, theme, editor save fixes, and browser suites. Do not reset, clean, auto-commit, or replace those changes. All builds/tests run on the project VM in isolated directories and storage. Never build into the live preview's `dist/web` for packaging verification: the running service serves that directory, so a build there changes deployment without a restart.

## Evidence and current gaps

Read: `AGENTS.md`, `README.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md`, `docs/HANDOFF.md`, `docs/ROADMAP.md`, manifest, core graph/storage/HTTP code, relevant tests and browser scripts.

- `docs/ROADMAP.md:5-19` confirms personal self-hosting, no mandatory cloud, and a standalone core. It supersedes the older Canvas-native executor direction. This proposal pulls packaging safety work forward without requiring a real cron example, financial evidence, adapter, trigger, or execution pilot.
- `src/graph/types.ts:1-4`: current graph schema is 3; readable versions are 1, 2, 3. `src/graph/migrate.ts` migrates graph documents forward; `src/graph/store.ts:116-130` validates the result. Loading a document does not persist its migrated JSON.
- `src/graph/store.ts:44-58,269-280`: database table upgrades occur on opening the store, with no explicit database version and no single migration transaction around the upgrade. This is separate from lazy graph migration.
- `src/graph/validate.ts:120-124` checks duplicate node/edge IDs, dangling references and dependency cycles. It does not yet enforce duplicate group/source/checklist/port IDs.
- `src/graph/store.ts:242-255`: existing Duplicate creates a fresh workflow ID and revision 1, retaining internal graph IDs. Those are scoped to a workflow, not global identities.
- Library project membership/order/timestamps live outside workflow JSON. A single workflow export cannot be a complete installation backup.
- `src/http/server.ts` provides CRUD/library operations, bounded JSON input and origin checks, but no authentication or import/export routes. Requests with no Origin are accepted, so origin checks are not authentication.
- `web/src/App.tsx:324-333`: `settle()` returns void, including when saving fails. Export must not equate a resolved settle promise with a successful save.
- `package.json` and the lockfile pin dependencies and Node. There is no tracked Dockerfile or Compose package. README/PLAN and older HANDOFF sections understate work now present; reconcile them rather than copying stale claims.
- Read-only VM inspection showed the existing preview running with a loopback-only published port. It was not restarted or changed. No data volume was opened for this planning work.
- HANDOFF records passing earlier editor/theme suites. They were not rerun in this planning turn and are not acceptance evidence for a self-hosting release.

## Contracts to approve

### A. Workflow export/import is not backup/restore

Use the current versioned `WorkflowDefinition` JSON as the initial interchange format, not an unnecessary second wrapper version. Export validated definitions only. No service configuration, authentication material, database paths, project IDs, harness credentials/job identities, run records or financial evidence are added to the format.

A private export preserves human-authored text and provenance. It is **not automatically safe to publish**: briefs, specs, URLs and source text can contain secrets or local paths. Show a warning and offer a reviewable sharing copy later if needed; do not silently redact lossless personal exports. Public fixtures/defaults must be synthetic and reviewed. Never resolve source references against the filesystem or fetch URLs during import.

### B. Identifier and revision rules

| Situation | Proposed behavior |
|---|---|
| Valid import, workflow ID absent | Preserve workflow ID and internal IDs; create at revision 1. Imported revision is source metadata, not authority over destination concurrency. |
| Workflow ID already exists | Return `409 identifier_conflict`; no overwrite, merge or silent rename. Offer explicit **Import as copy**. |
| Explicit Import as copy | Generate fresh workflow ID; retain internal IDs in their workflow-local namespaces; revision 1. Return assigned ID and navigate only after commit. |
| Repeated import after uncertain network result | Default preserve-ID retry conflicts rather than duplicating. A short-lived request identifier makes explicit copy requests retry-safe. Bind retry identity to normalized payload/options; mismatched reuse is an error. |
| Duplicate identity inside one scoped collection | Reject with field paths before writing; never guess which node/reference an edge meant. |
| Same internal ID in separate workflows | Allowed. No global remap is needed. Future cross-workflow references must be explicitly namespaced. |
| Replace existing workflow | Not part of the first import slice. Continue to use normal revision-checked editing. Any later replace needs explicit preview, expected destination revision, and confirmation. |
| Full backup restoration | Preserve exact stored workflow revisions, IDs, project membership, ordering and timestamps. It is not import-as-new. |

Define uniqueness for nodes, edges, groups and sourceReferences within their respective workflow collections; setup IDs within a node; input/output port IDs within each directional collection. Require distinct group membership entries. Cross-type IDs do not become globally unique accidentally. Validate special strings safely using Map/Set, not prototype-sensitive plain-object indexing.

### C. Version compatibility

Maintain separate documented numbers for application release, workflow schema and database layout. Read supported legacy graph versions, validate their legacy required structure before migration, migrate in memory, then validate current output. Reject missing, fractional, negative and future versions with actionable errors. Do not allow migration defaults to turn malformed input into a silently emptied graph.

Current-version round trip preserves all definition fields and IDs, with destination revision reset explicitly documented. Legacy export is normalized to the current graph schema, not a claim of byte-identical legacy export. Unknown fields continue to be excluded from canonical definitions, but import preview must report discarded fields so the user can cancel instead of silently losing content.

Stricter duplicate validation can expose previously stored invalid records. Preflight and report them without rewriting or deleting them; retain the original backup. Do not quietly reinterpret existing graph IDs during a database upgrade. Future/unsupported database layouts must fail before any CREATE/ALTER or workflow write.

### D. Single-user access

Keep the established simple access-token direction, with no account service. Proposed packaged default: authentication required even on loopback; an operator-generated high-entropy token provided via a read-only secret file, no default token and no token in URLs, browser storage, image layers, logs, examples or normal environment dumps. A local CLI generates/rotates the token directly to a restrictive-permission file without printing it.

Browser login exchanges the token for a short-lived server-side session. Use HttpOnly, SameSite=Strict cookies, explicit expiry/logout, timing-safe secret verification, bounded login attempts, origin/Host checks and CSRF protection on writes. Use Secure cookies over HTTPS; permit non-Secure cookies only in explicit loopback HTTP mode. Keep tokens out of localStorage. Reject missing/weak/unreadable token configuration before opening/migrating the database or listening.

Gate all data routes, including library, projects, import, export and future additions. Only static login assets and a minimal health response may be unauthenticated; health must not reveal paths, workflows or configuration. Sessions can be intentionally invalidated on restart, rotation and restore; document that graph persistence and login persistence are different things. Reauthentication must not silently discard unsaved editor changes.

No shipped unauthenticated mode in the Compose package. Keep the currently running legacy installation unchanged until approved migration. Private-server access uses a separately configured SSH tunnel or HTTPS reverse proxy; default Compose publishes only loopback and does not provision either. Do not trust arbitrary forwarded headers or infer trusted origins from attacker-controlled Host values.

## Ordered implementation slices

Each coding increment follows: add failing tests → run focused tests on the VM in approved isolation → minimal implementation → run tests/typecheck → independent review. Expected results below are acceptance requirements, not claimed outputs. Do not commit or push without a separate request.

### Slice 1: Compatibility and validation contract

**Objective:** Establish the graph compatibility boundary before accepting external files.

**Existing files:** `src/graph/types.ts`, `src/graph/migrate.ts`, `src/graph/validate.ts`, `test/validate.test.ts`, `test/migrate.test.ts`, `test/fixtures.ts`, `docs/ARCHITECTURE.md`.
**Proposed new files:** `docs/DATA-COMPATIBILITY.md`, `test/compatibility.test.ts`.

1. Write fixtures for each supported schema and every ID scope using synthetic non-financial content.
2. Test malformed legacy arrays/fields, future/fractional versions, duplicate IDs, group members, special-string IDs, dependency/revision cycles and inert hostile text.
3. Add legacy-input preflight and scoped duplicate checks without silently repairing identity.
4. Document import normalization, unknown-field reporting, supported read/write versions and destination revision semantics.
5. Verify supported documents preserve text/provenance/layout and that invalid inputs cannot produce partial writes. Retain legacy migration tests proving reads do not rewrite stored JSON.

**Gate:** Compatibility tests pass, including accepted cases, and no change to deployed storage or binding.

### Slice 2: Transactional workflow interchange API

**Objective:** Implement bounded, validated export/import without overwrites.

**Existing files:** `src/graph/store.ts`, `src/http/server.ts`, `test/server.test.ts`, `test/store.test.ts`, `test/library.test.ts`.
**Proposed new files:** `src/graph/interchange.ts`, `test/interchange.test.ts`.

1. Add pure parse/migrate/validate/normalization reporting tests first.
2. Add `GET /api/workflows/:id/export` and a non-mutating import validation route; use an attachment filename constructed safely, not raw user text in response headers.
3. Add `POST /api/workflows/import` with explicit mode and destination project selection. Default destination is Unfiled; never infer a destination project from an exported host's IDs.
4. Insert validated workflow plus library placement atomically. Handle ID collision at the database uniqueness boundary to cover races, not only in a prior existence query. Store copy-request retry identity transactionally with its result.
5. Enforce the existing body limit, strict media type, bounded collections/depth and safe traversal. Return stable errors: malformed `400`, too large `413`, media type `415`, validation/version `422`, identity collision `409`.
6. Test concurrent/repeated imports, invalid destination, interrupted transaction, retry after a lost response, and independent subsequent editing of original/copy.

**Gate:** Export → fresh-store import → export has the documented semantic equality; every rejected import leaves workflows, revisions and library ordering unchanged. Existing direct API consumers still work under the unchanged legacy runtime until the auth cutover is approved.

### Slice 3: Browser import/export with explicit save state

**Objective:** Make interchange usable without exporting stale work or hiding conflict errors.

**Existing files:** `web/src/App.tsx`, `web/src/Shell.tsx`, `web/src/api.ts`, `web/src/styles.css`, `test/editor-browser/editor.spec.mjs`.
**Proposed new files:** `web/src/ImportDialog.tsx`, `test/editor-browser/interchange.spec.mjs`.

1. Make the editor's save-settle result distinguish success, failure, pending load and conflict; update callers without regressing rapid-switch behavior.
2. Add export that waits for the acknowledged save and identifies the exported revision. If a newer local edit arrives, wait or explain which saved revision is exported. Block misleading downloads on failed/stale saves.
3. Add local file selection, bounded parsing, server validation preview, migration/discarded-field warnings, destination choice and explicit confirmation.
4. On identity conflict, offer cancel or copy; no silent overwrite or automatic repeated copy. Preserve the current editor until import commits.
5. Browser-test download contents, actual upload, cancellation, unknown schema, ID collision, copy, save failure, XSS-like text and repeated request behavior.

**Gate:** User-created content survives a browser export/import round trip and reload. Imported data never starts a command, network fetch or workflow run. No change to the live preview build.

### Slice 4: Consistent backup and tested restoration

**Objective:** Provide an actual recovery path before changing database startup or access controls.

**Proposed new files:** `src/maintenance/backup.ts`, `src/maintenance/restore.ts`, `test/backup-restore.test.ts`, `docs/BACKUP-RESTORE.md`.
**Existing files likely touched:** `src/graph/store.ts` only for shared non-mutating validation support; `package.json` for maintenance entry points.

1. Implement a stopped-service backup first. Short downtime is acceptable for a single-user app; online snapshots can be a separate later slice using a verified SQLite snapshot API. Never copy just an active `.sqlite` file or assume WAL checkpointing alone makes a concurrent copy safe.
2. Require the managed service/writers to be stopped, verify an exclusive database access window, and refuse unknown external writers. Use SQLite to produce a standalone consistent snapshot including committed WAL state, rather than copying a main file and hoping sidecars are unnecessary. Verify the exact snapshot API against the pinned Node runtime before implementation.
3. Write into a private temporary destination, integrity-check it, inventory projects/workflows and stored schema versions, produce a versioned manifest with app/runtime identity and SHA-256 checksums, then atomically finalize. Failure must not replace a previous good backup.
4. Back up all application data, not only graph JSON. Keep a separate, explicit configuration/secret recovery checklist. Secrets stay in protected local storage, not the portable definition export. A lost token may be rotated; do not restore active sessions. Warn that backups contain private text and need restricted permissions and operator-controlled encrypted/off-machine storage.
5. Restore first into a **new empty data location**. Validate manifest, checksums, sizes, SQLite integrity, layout compatibility, workflow validity and library relationships before permitting activation. Refuse populated targets by default. Never restore into a database an application has open.
6. Test actual restore after destroying a disposable source volume. Compare full content, IDs, revisions, groups, sources, brief, setup/readiness, project assignment/order and timestamps; boot the restored application and edit/reload it.
7. Add failure tests for corrupt/truncated backup, wrong checksum, future layout, insufficient permissions, interrupted writes and populated target. No failure may damage source data or erase the last good backup. Avoid user-controlled archive extraction paths; prefer a fixed manifest plus database layout for the first format.

**Gate:** A backup is not accepted until restoration and application read/write are demonstrated on throwaway data. Record the snapshot's last committed state; browser edits not acknowledged as saved are not in it.

### Slice 5: Versioned database upgrade and rollback safeguards

**Objective:** Make database changes deliberate, atomic and reversible through restoration.

**Existing files:** `src/graph/store.ts`, `src/http/main.ts`, `test/library.test.ts`, `test/migrate.test.ts`.
**Proposed new files:** `src/graph/db-migrate.ts`, `test/db-migrate.test.ts`, `docs/UPGRADE-ROLLBACK.md`.

1. Add read-only layout detection and a separate database schema version, recognizing both existing legacy layouts before choosing a migration.
2. Replace ad-hoc startup ALTER steps with ordered transactional migrations; preflight unknown/future layouts before any mutation. Reject corrupt/inconsistent row ID/revision versus JSON metadata and dangling project data, rather than silently dropping it.
3. Require verified pre-upgrade backup and explicit maintenance migration for a populated older database. A genuinely empty installation may initialize itself. Keep lazy document migration separate from table changes.
4. Inject failures between DDL/data steps and assert rollback; test repeated migration and concurrent startup locking.
5. Establish an immutable prior-version test baseline. Since valuable work is uncommitted, retain a private working-tree snapshot and exact prior image/config identity with approval; a Git SHA alone is not sufficient to recover today's preview bundle.
6. Test upgrade from pre-projects and current layouts, retaining raw legacy graph rows until saves. Test an older app refusing an unsupported newer database where supported by that older app's guard; otherwise never run it against the upgraded data.

**Gate:** Upgrade preserves data, failed upgrade preserves the old database, and rollback runs the prior application against a restored pre-upgrade volume. Never claim that changing an image tag reverses a schema migration.

### Slice 6: Local single-user authentication

**Objective:** Protect the entire data API without cloud identity or weakening save behavior.

**Existing files:** `src/http/main.ts`, `src/http/server.ts`, `web/src/api.ts`, `web/src/Shell.tsx`, `test/server.test.ts`, `test/static.test.ts`.
**Proposed new files:** `src/http/auth.ts`, `src/maintenance/access-token.ts`, `web/src/Login.tsx`, `test/auth.test.ts`, `test/editor-browser/auth.spec.mjs`.

1. Test missing token startup failure, login/logout, expiry, rotation, constant-time comparison handling and bounded abuse behavior.
2. Add the secret-file loader and local generation/reset CLI; never print a token in tool/test output. Use synthetic short-lived test credentials only in isolated tests.
3. Add centralized route gating with an explicit small anonymous allowlist. Table-test every existing route and HTTP method with missing/invalid/valid authentication, including no-Origin requests.
4. Add session cookies and CSRF/origin/Host enforcement. Reject deceptive proxy headers; explicitly configure trusted proxy/origin only for an approved topology. Keep cross-origin defaults restrictive.
5. Add login UI and shared fetch handling; retain drafts or clearly warn on session expiry. Browser-test login, logout, expiry during editing, reauthentication, route coverage and absence of secrets in URLs/storage/logs.
6. Test restart/restore session invalidation with retained data, and recovery when the operator has lost the token file.

**Gate:** No unauthenticated graph/library/export access or write path. No runtime network activation. The existing installation is not changed to require auth until its cutover is approved.

### Slice 7: Reproducible local Docker Compose package

**Objective:** Package the reviewed application, not the operator's checkout and private files.

**Proposed new files:** `Dockerfile`, `.dockerignore`, `compose.yaml`, `.env.example`, `scripts/check-package.mjs`, `docs/SELF-HOSTING.md`.
**Existing files:** `package.json`, `package-lock.json`, `README.md`, `.gitignore` as needed.

1. Create a multi-stage build using verified digest-pinned bases and `npm ci --ignore-scripts` from the lockfile. Start from the documented pinned Node runtime; do not guess new digests. Record target platforms actually tested. Retain React build dependencies at build time, not an unnecessary runtime dependency tree.
2. Use a positive allowlist build context/COPY boundary. Exclude `INFRA.md`, `.git`, local plans, credentials, env files except sanitized templates, SQLite files/sidecars, backups, imported material, private captures, local builds and test artifacts. Test both source context and resulting image layers for leakage using synthetic sentinels.
3. Runtime is non-root, app code immutable, data under a generic container-owned path, named persistent volume with a reliable non-root initialization/ownership strategy. Test empty volume permissions; do not solve with world-writable storage or hardcoded host UID/path.
4. Configure a local build/image only, no publish workflow and no automatic pull of a mutable app tag. Keep every base/helper image digest-pinned; record resulting local image IDs for upgrade/rollback. No `latest` or unattended updater.
5. Default host publication, when separately approved for startup, is IPv4 loopback only. Container binding may be wildcard internally, but Compose host mapping must be explicit. No host networking, Docker socket, privileged container, tunnel, companion cloud service or unrequested proxy.
6. Mount the token as a read-only secret file. Require it to exist; no reusable sample secret or permissive fallback. Declare allowed origins explicitly for the documented local URL. Keep optional HTTPS private-server instructions separate from default configuration.
7. Include local health check, sufficient graceful-stop time, deliberate restart policy, resource expectations and writable temp paths compatible with hardening. Health must reflect usable storage/layout, not merely an accepting TCP socket, without leaking data.
8. Add maintenance commands/services for offline backup, restore and migration that are never activated by normal startup. Pin their images too. No destructive `down -v` in normal upgrade/uninstall examples; volume deletion requires an explicit data-loss warning and separate user action.

**Gate:** Static Compose/config validation, image/context privacy checks and local build pass. This is only a packaging gate, not release acceptance and not permission to start it.

### Slice 8: Fresh-install, upgrade, recovery and persistence qualification

**Objective:** Prove the package works for a new individual user and survives maintenance.

**Proposed new files:** `scripts/test-self-hosting.sh`, `test/self-hosting/`, `docs/SELF-HOSTING-ACCEPTANCE.md`.
**Existing files:** relevant Playwright configuration, `README.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md`, `docs/HANDOFF.md`, `docs/ROADMAP.md`.

Run only after approval for the isolated test infrastructure. Use unique project names, disposable synthetic volumes and separate build output, never the current preview service or data. Prefer in-container test networking without host publication; separately test the shipped loopback mapping in an approved environment. Cleanup must verify resources belong to the test run, preserve failure evidence, and never wildcard-delete operator volumes.

| Scenario | Required observed result |
|---|---|
| Fresh installation | Clean host/VM or clean approved Docker environment; documented prerequisites only, no developer bind mount/node_modules, no preexisting data or secret. Bootstrap credential, build/start, login, create project/workflow, edit graph, save, reload, export/import. Test the actual packaged image. |
| No mandatory cloud | After provisioning dependencies/images, deny external egress and repeat login/edit/save/import/export/restart. No hosted identity, database, CDN or telemetry needed. Distinguish runtime offline support from initial downloads. |
| Restart and recreation | Save nontrivial graph/brief and library order, restart container, verify through API and browser; remove/recreate application container on same volume and repeat. Reauthentication is expected; missing data is not. Include host/service restart in the approved throwaway environment. |
| Upgrade | Use the retained older app to create synthetic data, take verified backup, upgrade via documented procedure, validate all fields/order and subsequent edits. Handcrafted legacy fixtures supplement but do not replace a real old-app upgrade test. |
| Backup/restore | Take consistent backup, remove disposable source storage, restore to empty new volume, login and compare full database semantics through API/browser. Restart again and verify. |
| Rollback | Simulate migration/startup failure; return to retained previous app/config plus restored pre-upgrade volume. Verify IDs/revisions/content/order and read/write. Preserve failed candidate volume for diagnosis. |
| Authentication | Anonymous/invalid credentials refused for every data route, expiry/rotation/logout effective, hostile Origin/Host and CSRF denied, secret absence in logs/image/downloads. |
| Isolation/privacy | Listener inspection confirms only approved host interfaces; Docker config has no accidental IPv6/wildcard publication. Build context/images/examples contain no operator data. Unrelated running preview remains unchanged. |
| Failure behavior | Invalid/future-schema import, duplicate collision, read-only/full storage, corrupt backup and interrupted migration give actionable errors without false success or data loss. |

Commands to retain as regression checks inside the approved pinned VM/container environment: `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, existing theme/editor browser suites, plus the proposed self-hosting harness. Override Vite output into the disposable package/test directory instead of invoking a build that overwrites the live `dist/web`. Existing `scripts/editor-browser.sh` publishes a host loopback port and therefore must not be run before test-listener approval.

Record exact source snapshot/image IDs, Node/Docker/Compose versions, tested CPU/OS, commands, exit codes, test counts, sanitized API comparisons, browser traces and backup/restore checksums. Label unsupported platforms honestly: an amd64 Linux run does not certify macOS, Windows Docker Desktop or ARM. Add those environments before claiming support for them.

Reconcile stale documentation only in this approved implementation slice. Update HANDOFF with actual results and remaining gaps; do not promote historical pass counts to current release evidence. Dependency/license review remains a release gate. No release/push/publication is implied by passing qualification.

## Existing-installation cutover and rollback runbook

This runbook describes a later separately approved operation, not something performed now.

1. Inventory the current image/runtime, source including uncommitted files, served bundle, configuration, data location and access method into protected operator notes. Do not copy private values into public docs. Retain an immutable rollback application artifact; do not assume a live source bind mount preserves old code.
2. Ask users to save, wait for acknowledgements, stop writers in an agreed maintenance window, and take/verify the consistent backup. Record its cutoff; unacknowledged browser edits are not protected by it.
3. Rehearse restore and upgrade on a separate volume using synthetic data first, then an approved private copy if necessary. Keep current application, original volume, and rollback backup intact. Never attach old and new writers to the same SQLite volume.
4. After explicit cutover approval, stop the old application and start the qualified candidate against a separate restored/migrated volume with approved auth/origin/bind settings. Preserve the prior listener scope unless separately authorized.
5. Read back health, login, complete workflow/library contents, save/reload and restart-persistence. Do not delete the old resources after one healthy response.
6. On failure: stop candidate writes; retain the candidate volume and diagnostics; start the prior application/config against a fresh restore of the pre-upgrade backup (or the intact old volume if proven unchanged). Never point old code at the upgraded database. Verify content and a real edit/reload before declaring rollback complete.
7. Explicitly explain that rollback returns to the backup cutoff. Post-cutover edits may be lost unless separately recovered using a compatible reviewed path; do not silently merge schema versions. Keep failed state for later recovery.
8. Agree retention/removal separately. No infrastructure destruction, broad Git reset, image push or volume deletion is part of normal rollback.

## Tradeoffs and remaining decisions

- Recommended initial recovery method is stopped-service backup: a little downtime buys a simpler consistency boundary. Add online backups only if downtime becomes a demonstrated problem.
- Recommend preserve-ID import with explicit copy-on-conflict, and no replace/merge in the first release. This satisfies stable-identifier portability without risking overwrite.
- Recommend token-required packaging with short-lived local sessions, not multi-user accounts or OAuth. Multi-user permissions and Internet hosting need a separate threat model.
- Local authentication does not make plain HTTP safe on a LAN. Remote use needs an approved encrypted access method; the package default remains loopback.
- Automated privacy scanners are defense in depth, not proof that free text contains no sensitive data. Public examples must originate from synthetic fixtures, never scrubbed financial captures.
- Approval requested first: slices/order, duplicate/revision policy, stopped-service recovery, token/session approach, and exact isolated test scope. Live migration, private-server binding and publication stay separate decisions.

## Completion statement

This plan is complete when saved and grounded in the current tree. Self-hosting is complete only when the Slice 8 evidence exists and rollback has been exercised. An image build, a health response, an export file or a backup file alone is insufficient.
