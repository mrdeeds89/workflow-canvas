# Distribution plan

> **Proposal for review, not implemented, not approved.** Nothing here has been
> published, pushed, packaged, submitted to a catalog, or exposed. No build was
> run into the live preview, no service was started or bound, and no Canvas code
> was changed to produce this document. It plans distribution to individual
> Hermes users while keeping Canvas a standalone, self-hosted core. The
> implementation work it refers to lives in
> `.hermes/plans/2026-10-30_193740-personal-self-hosting.md` (Slices 1–8) and is
> itself unbuilt and unapproved.

Refines `docs/ROADMAP.md` step 8 (Distribution). The Hermes Desktop plugin
half is assessed separately in `docs/DESKTOP-PLUGIN-ASSESSMENT.md`.

## 1. Four distinct release actions (keep them separate)

Each is a separate decision with its own approval. Doing one never implies the
others.

| # | Action | What it means | Status today |
|---|---|---|---|
| A | **Publish source** | The Git repository is readable. | Already done: `github.com/mrdeeds89/workflow-canvas`, MIT. Publishing source does **not** deploy anything. |
| B | **Release a container/package** | A versioned, digest-pinned image + Compose bundle a user installs on their own machine. | **Not built.** Self-hosting plan Slice 7. |
| C | **Publish a plugin** | Ship the thin Hermes Desktop plugin (a plugin folder, or a catalog entry). | **Not built.** See `docs/DESKTOP-PLUGIN-ASSESSMENT.md`. |
| D | **Expose a running service** | Bind Canvas to a reachable interface, or put a tunnel/reverse proxy in front of it. | **Out of scope and unapproved.** Default stays IPv4 loopback. Requires the auth slice (Slice 6) first, then a separate exposure decision. |

The standalone core is action A plus the user running B on their own hardware.
A user never needs C or D to use Canvas.

## 2. Versioning

Today `package.json` is `0.0.0` and there are **no git tags**. Introduce three
independent, separately documented numbers (self-hosting plan Contract C):

- **Application release** — SemVer, git-tagged `vMAJOR.MINOR.PATCH`, with a
  `CHANGELOG.md`. Pre-1.0 while execution is absent and the API may move.
  Proposed first tag: **`v0.1.0`** — design-only editor, no execution,
  loopback-only, matching the committed tree.
- **Graph schema version** — currently **5** (`src/graph/types.ts`). Readers
  migrate 1→5 in memory; the stored row is rewritten only on save. Bumped only
  when the document shape changes.
- **Database layout version** — currently **unversioned** (tables are upgraded
  in place on open). Slice 5 introduces an explicit DB-layout number and
  transactional migrations. Until then, DB rollback leans entirely on backups.

A release records which schema and DB-layout versions it reads and writes.
Changing the app version never silently changes a stored document's revision.

## 3. Install / update / uninstall (package sense, action B)

Concrete commands depend on the unbuilt Compose package (Slice 7). Shape only:

- **Install (clean machine):** install Docker + Compose; fetch the pinned
  images by digest; generate a local access token to a restricted-permission
  secret file (no default token, never printed); `docker compose up -d`; open
  the documented loopback URL; log in. No bind mount of a developer checkout,
  no `node_modules`, no preexisting data.
- **Update:** pull the new digest-pinned image for the target version; take a
  verified backup first (step 5); `docker compose up -d`; verify health, login,
  and a real edit/reload. No `latest` tag and no unattended updater; every base
  and helper image stays digest-pinned.
- **Uninstall:** `docker compose down` (stops and removes containers, keeps the
  named data volume). **No `down -v` in the normal path.** Deleting the data
  volume is a separate, explicitly data-loss-warned action the user runs by
  hand. The token secret file is removed by the user.

## 4. Migration and rollback

- **Document migration** is lazy and in-memory (schema 1→5); a read never
  rewrites the stored JSON. Keep that property.
- **Database migration** (Slice 5) must be ordered, transactional, and
  preflighted: a future/unknown layout fails before any `CREATE`/`ALTER`/write;
  a failed migration leaves the old database intact.
- **Rollback is restore, not a tag flip.** Changing the image tag back does
  **not** reverse a schema or DB-layout migration. Rollback = start the prior
  application artifact against a *restored pre-upgrade backup volume* (Slice 4/5
  and the cutover runbook in the self-hosting plan). Never point old code at an
  upgraded database; never attach two writers to one SQLite volume.
- **Backups contain private text** (briefs, specs, URLs). They need restricted
  permissions and operator-controlled storage, and are never part of a public
  export.

## 5. Sanitized example workflows and exports

### Audit result (this task, against the git-tracked tree)

A scan of every tracked file for lab IPs, hostnames, `/home/<user>` paths, lab
domains, agent/profile names, chat IDs, and credential patterns found **no real
private data in the tracked tree**. Specifically:

- `examples/research-workflow.json` — synthetic (a generic research→draft→
  review→approve→publish graph). Clean.
- `examples/hermes-observations/*.json` — synthetic observations (profile
  `example`, placeholder job IDs `a1b2c3…`, generic job names, fake SHA-256
  fingerprints `1111…`). Clean.
- `examples/hermes-observations/harness-config.*.json` — placeholders only
  (`harness.example.lan`, `/srv/workflow-canvas/private/...`). Clean.
- The only matches for secret-like strings are **intentional negative fixtures**
  in `test/harness-exporter.test.ts` and `test/harness-observation.test.ts`
  (e.g. `sk-SECRET`, `10.20.30.40`, `telegram:-100…`, `/home/x/run.sh`,
  `SECRET PROMPT`). These are inputs that prove the exporter *strips* such data;
  they are fake and safe to ship. They are not leaked values.
- Private surfaces are gitignored and untracked: `INFRA.md`,
  `PRIVATE-BACKUP.md`, `private/`, `backups/`, `data/`, `*.sqlite*`, `*.bundle`,
  `id_*`, `/harness-config*.json`.

### Standing sanitization rules for examples and future exports

- Public fixtures/defaults are synthetic and reviewed, never scrubbed real
  captures (especially never financial captures).
- The workflow export route (Slice 2/3, unbuilt) exports validated definitions
  only — no service config, no auth material, no DB paths, no harness
  credentials or job identities, no run records, no financial evidence.
- A lossless personal export is **not automatically safe to publish**: briefs,
  specs, and URLs can carry secrets or local paths. The design shows a warning
  and offers a reviewable sharing copy; it does not silently redact.
- Import never resolves source references against the filesystem or fetches
  URLs. Imported text is data, never instructions.
- Re-run the tracked-tree scan on every release (checklist item below).

## 6. Dependency and license review (real data, this task)

Enumerated from the installed tree (61 packages).

- **Runtime third-party dependencies: zero.** `package.json` has no
  `dependencies` block. The server runs on `node:http` + `node:sqlite`
  built-ins only (`node:sqlite` is experimental in Node 22 and pins the
  runtime). All 61 packages are dev/build/test-time.
- **What ships in the browser bundle** (`dist/web`): `react`, `react-dom`,
  `@xyflow/react`, `@xyflow/system`, `zustand`, `classcat`, `scheduler`,
  `use-sync-external-store`, and `d3-*` (via xyflow) — all MIT / ISC / BSD-3.
  Clean for MIT redistribution.
- **License breakdown (all 61):** MIT (majority), ISC (`d3-*`, `picocolors`),
  BSD-3-Clause (`source-map-js`, `d3-ease`), Apache-2.0 (`typescript`,
  `playwright*`, `detect-libc`), and **MPL-2.0** on `axe-core`,
  `@axe-core/playwright`, and `lightningcss`. All permissive and MIT-compatible.
  MPL-2.0 is weak (file-level) copyleft, but those three are **test/build-time
  only** (`axe-core` = Playwright a11y checks; `lightningcss` = a Vite CSS
  transform) and nothing MPL-licensed ships in the distributed bundle or image,
  so no copyleft obligation flows to users.
- **Gate:** the lockfile is exact-pinned; install is `npm ci --ignore-scripts`.
  Re-run this enumeration on each release and flag any new non-permissive
  license before tagging.

## 7. Clean-machine acceptance test

Two layers.

### a. Current whole-tree gate (buildable today, pinned container)

Against an isolated `git archive` of HEAD (not the working tree), in the
README-pinned image
`node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd`:

```
npm ci --ignore-scripts && npm run typecheck && npm test && npm run build
```

Plus the browser suites on the project VM (throwaway container, loopback-only,
temporary DB, never the preview build/volume): `bash scripts/test-browser.sh`
(theme) and `bash scripts/editor-browser.sh` (editor + restart). `scripts/
smoke-api.sh` is the running-service loopback check.

Latest recorded real results are in `docs/HANDOFF.md` (R2.1: 178 Node tests
pass, typecheck + build clean). A fresh clean-tree run for this document is
recorded in **§9 Verification** below.

### b. Fresh-install qualification (needs the unbuilt package — Slice 8)

The real "clean machine" test for action B. Full matrix in the self-hosting
plan Slice 8: fresh install on a clean host with documented prerequisites only;
no-mandatory-cloud (egress denied after provisioning); restart + container
recreation on the same volume; upgrade with backup; backup/restore onto an
empty volume; rollback; authentication on every data route; isolation/privacy
(listener inspection, image/context leak scan with synthetic sentinels);
failure behavior. **The existing Chromium suites do not replace this install
test.** Record exact image IDs, Node/Docker/Compose versions, tested CPU/OS,
commands, exit codes, counts, and checksums; an amd64 Linux run does not
certify macOS, Windows Docker Desktop, or ARM.

## 8. Release checklist

Legend: [x] done · [~] partial · [ ] not started.

- [x] Source is public under MIT with a clean snapshot base (`docs/HANDOFF.md`).
- [x] Private surfaces gitignored and untracked (verified this task).
- [x] Tracked-tree sanitization scan clean (verified this task; §5).
- [x] Example workflows synthetic and reviewed (§5).
- [x] Dependency/license review: no runtime third-party deps; all licenses
      permissive and MIT-compatible; nothing copyleft ships (§6).
- [x] Hermes Desktop plugin interfaces verified; embedding/renderer-fetch ruled
      out, open-in-browser launcher confirmed (`docs/DESKTOP-PLUGIN-ASSESSMENT.md`).
- [x] Current whole-tree gate passes on a clean HEAD archive (§9).
- [ ] Versioning introduced: SemVer app version, first tag `v0.1.0`,
      `CHANGELOG.md`, documented schema (5) and DB-layout numbers (§2).
- [ ] Validated JSON import/export with export sanitization warning (Slice 2/3).
- [ ] Backup/restore implemented and tested on throwaway data (Slice 4).
- [ ] Explicit DB-layout version + transactional migration + rollback (Slice 5).
- [ ] Single-user authentication on every data route (Slice 6).
- [ ] Digest-pinned Dockerfile + `.dockerignore` allowlist + `compose.yaml` +
      `.env.example`, with image/context leak scan (Slice 7).
- [ ] Fresh-install / upgrade / recovery / persistence qualification (Slice 8).
- [ ] Thin desktop plugin built, if wanted (action C).
- [ ] Install/update/uninstall user docs finalized against the real package.

Approval gates (each separate, none implied): tag + publish a release (A/B),
publish the plugin (C), expose a running service (D).

## 9. Verification (this task)

Read-only and isolated. No service started, bound, or exposed; no Canvas code
changed; the live preview was not rebuilt or restarted; no commit, tag, or push.

- Mount proven: `findmnt` shows `fuse.sshfs` from the canonical VM source before
  any read.
- Sanitization scan: tracked tree only; results in §5.
- License enumeration: 61 installed packages; results in §6.
- Plugin interfaces: verified against the SDK reference and Canvas source
  (`frame-ancestors 'self'` at `src/http/server.ts:66`; no CORS headers; Origin
  allowlist at `src/http/server.ts:157`).
- Current whole-tree gate: isolated `git archive` of HEAD `ca2dd3c` into a
  throwaway VM temp dir, pinned image `node:22-bookworm@sha256:18a6d90f…`, not
  the preview volume. `npm ci --ignore-scripts` + `npm run typecheck` + `npm
  test` + `npm run build` all passed: **178 Node tests pass / 0 fail / 0
  skipped**, build transformed 186 modules into `dist/web` (JS 473.33 kB / gzip
  147.70 kB, CSS 37.32 kB). Temp dir removed afterward. Browser suites
  (`test-browser.sh`, `editor-browser.sh`) not re-run this task; last recorded
  real results in R2.1 handoff sections.

## 10. Open questions

Defaults in force unless Dom changes them.

1. First application tag `v0.1.0` while design-only and pre-execution? Default:
   yes.
2. Does the thin plugin ship in this repo (`plugin/`) or a separate repo?
   Default: here, versioned with the schema it targets.
3. Is action D (any exposure beyond loopback) in scope for the first
   distribution at all? Default: no — loopback only until auth (Slice 6) lands
   and exposure is separately approved.
4. Order of build: does distribution packaging (Slices 1–8) come before or
   after the R2 conductor/execution work? Default: Dom decides; they are
   independent tracks and this document assumes neither.
