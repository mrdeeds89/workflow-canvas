# Hermes integration proposal

Status: **read-only prototype built; not installed on any harness.** Dom approved the build on 2026-10-30. The exporter, Canvas storage, routes, panel, examples and tests exist in this repository (see `docs/HANDOFF.md`). No key or exporter is installed on a Hermes host, and no cron job was created, edited, paused, resumed, or fired. Installing on a harness is a separate approval. It refines roadmap steps 5 to 7 in `docs/ROADMAP.md`.

Verified against Hermes Agent 0.22.5 and the official documentation at hermes-agent.nousresearch.com/docs (cron feature guide, cron internals, API server, web dashboard, Desktop plugin SDK, MCP, observer hooks, programmatic integration), plus that release's source where the docs were silent. Re-verify on every Hermes upgrade: the interfaces below are versioned by Hermes, not by this project.

## 1. Who owns what

One scheduler. Hermes. Canvas never decides *when* anything runs and never starts work.

| Concern | Owner | Canvas role |
|---|---|---|
| Workflow definition (cards, arrows, brief, trigger *intent*) | Canvas | Authoritative, versioned, exportable |
| Presentation | Canvas (Desktop plugin optional, later) | Renders definitions and observed evidence side by side, never merged |
| Agent-assisted editing | Canvas, via revision-bound proposals | Accept/reject is a human action (milestone 3) |
| Job scheduling (schedule, timezone, enabled/paused, next run) | Hermes cron | Read-only display of the harness's value |
| Dispatch (claim, fire, retry, catch-up, at-most-once per occurrence) | Hermes cron | None. No run, trigger, or resume route |
| Run evidence (attempts, status, delivery outcome) | Hermes execution ledger | Copies an allowlisted, timestamped observation; never edits it |
| Credentials (model keys, platform tokens, dashboard login) | Hermes | Never held, proxied, or displayed |

**Trigger intent and the real schedule.** The 2026-10-30 decision says triggers are designed and saved on the workflow. That saved trigger is intent. Once a workflow is linked to a Hermes job, the job's schedule is the authority and is shown as observed. If the two differ, Canvas shows "design differs from harness" and stops there. It does not sync in either direction, does not create a job to match, and does not copy the schedule into its own store as a second source of truth.

## 2. What Hermes actually exposes (observed, 0.22.5)

| Interface | Reads | Also allows | Auth | Fit |
|---|---|---|---|---|
| Web dashboard REST `/api/cron/jobs`, `/api/cron/jobs/{id}`, `/api/cron/jobs/{id}/runs` | Jobs, state, run history | Create, edit, pause, resume, trigger, delete; the same login also reaches `.env`, config, sessions | One admin session (password/OAuth gate on a non-loopback bind; none on loopback) | Right data, far too much authority |
| API server `/api/jobs`, `/api/jobs/{id}` | Job definition and last-run state | `POST /api/jobs/{id}/run`, create, `PATCH`, `DELETE`, plus `/v1/runs` (start an agent run with full tools) | One bearer key, no read-only scope | Same key starts work. Not acceptable for a read path |
| Desktop `host.request` → `cron.manage` | `list` | `add`, `remove`, `pause`, `resume` through the same method | Desktop session | Write-capable door; plugins are documented as not sandboxed |
| CLI `hermes cron list`, `cron runs`, `cron status` | Human text | Sibling subcommands mutate | Shell as the Hermes owner | No JSON output; text is not a contract |
| Python `cron.jobs`, `cron.executions` | Full records | Everything | Shell as the Hermes owner | Internal, unversioned. Importing it is not side-effect free (see below) |
| `jobs.json` and `cron/executions.db` on disk | Full records | Nothing, if opened read-only | Filesystem | Internal format; needs a version gate |
| MCP | Hermes is an MCP *client*. Hermes-as-MCP-server is the separate `mcp-serve` catalog plugin, not installed or inspected here | Whatever tools are exposed | Per server | A tool transport. Says nothing about scheduling semantics |

Facts that drive the design:

- **There is no read-only credential.** Every supported HTTP surface that can read cron with a credential can also fire or delete jobs.
- **`last_status` is not "the user got it".** Literals are `ok`, `delivery_queued`, `error`, `delivery_failed`, `blocked_config`. Hermes's own docs say a consumer must never test `== "ok"` alone. A never-run job has none.
- **Displayed state is derived.** Hermes computes the operator state (`scheduled`, `paused`, `completed`, `running`, `error`) from `enabled`, `state`, and pause markers. An enabled job with a leftover `state: "paused"` displays as `scheduled`. Reading the raw `state` field is wrong.
- **Executions are durable and per occurrence.** Each attempt is a row: `claimed | running | completed | failed | unknown`, with `scheduled_instant`, `delivery_outcome`, `progress_at`. An off-schedule fire carries no occurrence.
- **The raw job record holds private material.** It carries prompt text, delivery target with chat IDs, origin, script path, working directory, model/provider/base URL, monitor URL, and free-text errors. Run history can carry agent output.
- **Importing Hermes's Python is not read-only.** In a spike against a *copy* of one profile's cron store, the cron files came through byte-identical, but importing Hermes modules seeded two new files into the home directory it pointed at. On a live home that is probably a no-op. "Probably" is not a read-only guarantee.

## 3. Options compared

| | Native adapter (Canvas ↔ harness-side exporter) | MCP | Desktop plugin |
|---|---|---|---|
| Presentation | In Canvas, the canonical surface | None by itself | Inside Hermes Desktop only |
| Agent-assisted editing | Possible but not its job | **Best fit.** Canvas as an MCP server exposing read + *proposal* tools, revision-bound | Indirect |
| Scheduling | Never | Never. A tool call is not a schedule | Never |
| Dispatch | Never in this phase | Dangerous by default: a "run job" tool makes any connected agent a dispatcher, with no claim, occurrence, or approval semantics of its own | `cron.manage` can mutate |
| Run evidence | **Best fit.** Deterministic, allowlisted, timestamped | Agent-mediated: an LLM in the read path is non-deterministic and needs wider tools | Can read, but evidence lives in a plugin, not in Canvas |
| Install footprint on the harness | One small script and one restricted SSH key; no Hermes config change | A new MCP server entry in Hermes config | A plugin in the Desktop root plus an optional backend; gateway restart for backend routes |
| Permission breadth | Narrowest available | Per tool, but trust is whatever the server exposes | App-level across every connected gateway; documented as not a sandbox |
| Separate hosts | Works: app server pulls over SSH; laptop never talks to the harness | Works for agent ↔ Canvas | Desktop must reach both Canvas and the gateway |

MCP support is not execution compatibility. MCP moves a tool call. It does not give at-most-once claims, occurrence accounting, catch-up rules, approval pauses, cancellation, or a durable ledger. Hermes cron already provides those. Any later dispatch path has to go through Hermes's own scheduler, not around it.

**Recommendation.** Native read-only adapter for evidence (this prototype). MCP later, as Canvas-as-server for agent-assisted editing proposals (roadmap step 6), never for scheduling or dispatch. Desktop plugin optional and last, as a presentation of Canvas data, never the store.

## 4. Proposed prototype: read-only job link

### Hosts and data flow

```
laptop browser ──(existing private access to Canvas)──▶ Canvas app server ──(SSH, forced command)──▶ harness host
     holds no harness credential               stores links + observations            runs read-only exporter
```

- The **laptop** only talks to Canvas. It never receives a harness address, key, or token.
- The **app server** holds one SSH private key per observed profile, outside the repository, mode 600, paths from configuration outside the repository. Each key can do exactly one thing: print a snapshot for its profile.
- The **harness host** gets no new listener, no Hermes plugin, no Hermes config change, and no cron job. Its `authorized_keys` gains one line **per Hermes profile** being observed, `restrict,command="<exporter> --profile <p>"`, which blocks a PTY and port, agent, and X11 forwarding. The profile is fixed by the key, not chosen by the caller. Separate profiles are separate agents, so each gets its own key: revoking one does not affect another, and one key cannot read another profile's jobs.

**Pull (decided 2026-10-30; no manual-import phase).** The app server runs the exporter over the forced-command key, on page view or a Refresh click, at most once per 60 s per link. That is an observation poll, not a job schedule. There is no background timer in the prototype.

**Public and private split (decided 2026-10-30).** The public repository stays a blank canvas anyone can use: the exporter, the Canvas tables, routes, and panel, and three synthetic example jobs as fixture observations (for example a healthy daily digest, a script-only check whose delivery failed, and a paused weekly report). Which real jobs are linked, harness labels, keys, and observations are configured on the operator's own machines and never enter the repository. The first real links are two agent profiles on one harness host, so both agents can test the panel.

### Exporter (harness side)

- Standard-library Python, run with `-I`. It **does not import Hermes**. It opens `cron/jobs.json` read-only. It writes nothing under `HERMES_HOME`.
- **Ledger read without side files.** Hermes keeps `executions.db` in WAL mode and closes it between writes, so there is usually no `-wal`/`-shm`. A plain `mode=ro` open creates both (observed in a spike against a copy), writes read-marks into `-shm`, and can race Hermes closing the database (found in review). So SQLite opens Hermes's file only as `immutable`. With no `-wal`, the main file is read directly and accepted only if it did not change during the read. With a `-wal`, the db and WAL are copied into a private temp directory, never inside the Hermes home whatever `TMPDIR` says. The copy is accepted only if neither original changed meanwhile, and is read there. Otherwise the exporter retries, then refuses with `store_unreadable`.
- **Version gate.** It reads the installed Hermes version and a fingerprint of the executions table columns. An unknown version or schema means `unsupported` output and exit non-zero. It never guesses.
- **State derivation.** A small port of Hermes's displayed-state rule, with a conformance test against Hermes's own function, run on copied fixture homes only.
- **Accepted arguments.** Only `snapshot <job_id>`. The job ID must match `^[0-9a-f]{6,32}$`. Anything else is refused.
- **Allowlist output.** Excluded fields are never read into the output, rather than read and then blanked.

### Observation format `workflow-canvas.hermes-observation`, version 1

```json
{
  "format": "workflow-canvas.hermes-observation",
  "version": 1,
  "observed_at": "2026-10-30T22:00:00Z",
  "harness": { "hermes_version": "0.22.5", "exporter_version": "0.1.0", "profile": "<profile>" },
  "scheduler": { "ticker_heartbeat_age_s": 10 },
  "job": {
    "job_id": "<id>",
    "name": "<untrusted text, max 200>",
    "schedule": { "kind": "cron", "display": "0 1 * * *" },
    "timezone": null,
    "display_state": "scheduled",
    "enabled": true,
    "next_run_at": "…", "last_run_at": "…",
    "last_status": "ok",
    "runnable": true,
    "paused_at": null,
    "has_error_detail": false,
    "delivery_kinds": ["telegram"],
    "fingerprint": { "definition_sha256": "…", "skills": ["…"], "script_present": true, "no_agent": false, "model_pinned": false }
  },
  "executions_available": true,
  "executions": [
    { "id": "…", "status": "completed", "source": "…", "scheduled_instant": "…",
      "claimed_at": "…", "started_at": "…", "finished_at": "…", "progress_at": "…", "delivery_outcome": "delivered" }
  ]
}
```

**Never exported:** prompt text, delivery chat/channel IDs, origin, script path, workdir, model, provider, base URL, monitor URL, error text, run output, session IDs, PID/process IDs, and any credential. `delivery_kinds` holds platform names only. `has_error_detail` says whether the harness holds error text, without sending it. `runnable` is Hermes's own fire gate: a disabled job, or one with a leftover pause marker, can display as `scheduled` yet never fire, and the panel says so. `definition_sha256` covers prompt, skills, script, model settings, schedule, timezone, workdir, toolsets, delivery and context, so Canvas can say "this job's definition changed since you linked it" without holding the definition. Executions are capped at the 10 newest. Status-like values that are not a plain lowercase word arrive as `unrecognized`.

### Canvas side

- **`harness_links`** (separate table): `workflow_id`, local `harness_label`, `profile`, `job_id`, `linked_at`, `linked_fingerprint`. One job per workflow in the prototype. Linking and unlinking **do not change the workflow revision** and are not part of the workflow document or any future export.
- **`harness_observations`** (last 20 per workflow): `observed_at` (harness clock), `received_at` (server clock), `source` (`ssh-pull`, or `example-fixture` for the public examples), a hash of the raw text, and the validated payload with only allowlisted fields. Re-linking to another job, unlinking, or deleting the workflow removes them. A pull that finishes after a re-link is discarded.
- **Age.** Measured on the server's clock from the earlier of `observed_at` and `received_at`. A harness clock ahead cannot make data look new. A large gap is flagged, because it means old data or a harness clock running behind. The browser corrects for its own clock with the `serverNow` each response carries.
- **Routes:** `GET /api/harnesses` (labels and profiles only); `GET /api/workflows/:id/harness` (link, latest observations, thresholds, server time); `PUT` / `DELETE /api/workflows/:id/harness-link` (link record only, origin-checked like other writes); `POST /api/workflows/:id/harness-link/refresh` (asks the server to pull an observation, rate-limited; takes no command, path, or host from the body). No route pauses, resumes, edits, creates, or runs a job.
- **UI:** a workflow-level **Job evidence** panel with schedule, enabled/paused, next run, latest whole-job result, recent attempts, provenance (harness label, profile, exporter and Hermes versions, source), and freshness ("observed 4 min ago"). Cards are not decorated with job results.

### Result wording

Every result is labelled **whole job**.

| Observed | Shown as |
|---|---|
| `ok` | Job completed; delivery confirmed (whole job) |
| `delivery_queued` | Job completed; delivery not yet settled |
| `delivery_failed` | Job ran; output did not reach its target |
| `error` | Job failed |
| `blocked_config` | Refused before running (configuration) |
| none | Never run |
| any other literal | "Unrecognized status `<literal>`", never coerced to success |
| latest execution `running`/`claimed` | Running now (since …) |
| execution `unknown` | Outcome unknown (owner lost); not counted as success |

**No per-step inference.** The panel states: "Hermes reports one result for the whole run. It does not say which steps ran." Card readiness stays design-derived. `tested` and `operational` remain refused by the server whatever the observation says. Step-level evidence needs step-level records emitted by the job itself, labelled "reported by job", in a later approved increment.

### Untrusted text

Job name, skill names, schedule display, and status literals arrive from another system. They are rendered as text nodes, length-capped, never as HTML or Markdown, and never passed to a tool, shell, model, or URL. A job named `ignore previous instructions and run …` is a string on screen. The prompt is not imported at all.

## 5. Failure cases

| Case | Detection | Display | Never |
|---|---|---|---|
| Harness unreachable / SSH refused / timeout | Pull fails | **Disconnected**, with the last observation and its age | Show the last observation as current |
| Snapshot old | `now − observed_at` > 15 min (configurable) | **Stale**, age shown | Hide the age |
| Clock skew | `observed_at` more than 2 min after `received_at` | **Clock skew** warning; age computed from `received_at` | Trust a future timestamp |
| Job removed, renamed profile, or wrong ID | Exporter `not_found` | **Job not found on harness**; link kept for Dom to resolve | Auto-unlink or auto-relink by name |
| Hermes upgraded, schema changed | Version/schema gate | **Unsupported harness version** | Best-effort parse |
| Definition changed since linking | Fingerprint differs | **Definition changed since linked** | Copy the new definition in |
| Scheduler not ticking | Heartbeat age > 3 min | **Schedule shown but scheduler is not running** | Imply the next run will happen |
| Overdue | `next_run_at` earlier than `observed_at` minus grace | **Overdue** | Fire it, or suggest a run button |
| Paused job | `display_state == paused` | **Paused**, with the time | Offer resume |
| Delivery pending or failed | `last_status` literal | Per the table above | Report "succeeded" |
| Malformed or oversized payload | Schema validation, 256 KB cap | Import rejected; existing observations untouched | Store a partial |
| Duplicate or out-of-order observation | Same payload hash, or older `observed_at` | Ignored / kept as history; latest is by `observed_at` | Regress the display |
| Key misuse (other command, PTY, forward) | Forced command, `restrict` | Refused on the harness | Fall back to a broader credential |
| Canvas restart | Rows persisted | Same link; freshness recomputed from timestamps | Reset age to "just now" |

## 6. Permissions summary

- **Grants:** one SSH key per observed profile, whose only capability is printing an allowlisted snapshot for that profile.
- **Explicitly not used:** the dashboard login, `API_SERVER_KEY`, Desktop `cron.manage`, an MCP connection into Hermes, Hermes's Python modules, and any write to `HERMES_HOME`.
- **Residual risk, stated plainly:** the forced command runs as the Hermes owner user. A bug in the exporter runs with that user's file access. Mitigations: tiny, reviewed, no shell, no Hermes import, read-only opens, argument regex, a fixed path not writable by the key. A dedicated read-only Unix user would be tighter but needs group permission changes on the harness. That is a separate decision.

## 7. Prototype acceptance checks

Run harness-side checks against **copied fixture homes** first, then a read-only before/after on the real harness only with approval.

1. **Exporter is read-only.** Against a copied home, the hashes of every file are identical before and after, and no file is created. Against the live harness (approved): `hermes cron list --all`, `hermes cron runs --limit 50`, and the execution row count are identical before and after, and no new listener appears in `ss -ltn`.
2. **Allowlist holds.** A fixture job with a known prompt, chat ID, script path, workdir, base URL, monitor URL, and error text: none of those strings appears anywhere in the exporter output, the Canvas database, or Canvas logs.
3. **Forced command holds.** `ls`, `snapshot ../x`, `snapshot abc; id`, an empty command, a PTY request, and `-L` forwarding are all refused, with no snapshot output.
4. **State derivation conforms.** Fixtures for enabled+leftover-paused, disabled+paused marker, completed, error, and running give the same display state as Hermes's own function on the same copies.
5. **Every display state renders.** From fixtures: fresh, stale, disconnected, not found, unsupported version, definition changed, clock skew, scheduler not ticking, overdue, paused, running, each `last_status` literal, an unrecognized literal, and an `unknown` execution. Chromium suite, throwaway database, loopback port.
6. **Definitions stay separate.** Link, refresh, and unlink leave the workflow revision and `GET /api/workflows/:id` byte-identical. The future export omits links and observations.
7. **No step inference.** After an `ok` observation, every card's readiness is unchanged, and a `PUT` asserting `tested` is still `422`.
8. **Untrusted text stays text.** A job name containing `<script>`, Markdown, and an instruction-shaped sentence renders literally. No request leaves the server as a result.
9. **No mutation surface.** A test enumerates Canvas routes and asserts there is no job create, edit, pause, resume, run, or delete. The exporter's argument parser accepts only `snapshot`.
10. **Persistence.** A link and its observations survive a Canvas restart, and freshness ages correctly afterward.
11. **Privacy.** Canvas still binds loopback. No key material is in the repository, database, observations, or logs. The key path comes from an environment variable.

## 8. Decisions (Dom, 2026-10-30)

1. **Transport:** straight to the forced-command SSH pull. No manual-import phase.
2. **Exporter:** independent of Hermes. No Hermes import; read-only file opens, a ported state rule with a conformance test, and a version gate.
3. **Scope:** the public repository is a blank, general-purpose canvas with three synthetic example jobs. Real links and their configuration live on the operator's machines. The first real links are two agent profiles on one harness host, chosen outside this repository.
4. **Error detail:** category only. The panel shows the `last_status` literal's meaning and whether the harness holds more detail. No error text leaves the harness.

Still open:

5. **Warning timings.** How old an observation may be before it is labelled stale, and how long the scheduler heartbeat may be silent before "scheduler is not running" appears. Proposed defaults: 15 min and 3 min, adjustable per link later.

Recording a decision is not approval to build or to install anything on a harness. Each of those still needs its own go-ahead.

## 9. Out of scope until separately approved

Creating, editing, pausing, resuming, or firing jobs; any dispatch or approval-gate enforcement; installing a Hermes or Desktop plugin; adding an MCP server on either side; a background poller; a non-loopback bind; production activation.
