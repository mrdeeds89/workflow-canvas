# R2 plan: connect a Hermes install, run, and deliver results

Status: **plan, not built.** Slice R2 of `docs/RUN-PLAN.md`, revised 2026-10-31 after Dom's answers (section 8). Everything is tested on throwaway Hermes homes and throwaway boards with no gateway, so nothing is dispatched to a worker. Installing on a real harness stays R4 with its own go-ahead.

## Goal

**Anyone with Hermes** can install Canvas, connect it to their Hermes, and run a workflow they reviewed. Hermes does the work. Each workflow's result goes wherever the user picks from what their Hermes can already send to: a Telegram chat or topic, Discord, Slack, Signal, Hermes's own chat, or a local file only.

Canvas still never executes. A small, model-free **conductor** on the Hermes machine pulls approved work from Canvas, creates Kanban tasks stage by stage, and sends the result with `hermes send`.

## Hermes facts this rests on (0.22.5, checked 2026-10-31)

- `hermes send [-t TARGET] [-f PATH] [-s SUBJECT]` sends text to any platform Hermes is configured for, with no model and no agent loop, and for bot-token platforms no running gateway. Targets look like `telegram`, `telegram:<chat>:<thread>`, `discord:#channel`, or `slack:<id>`. `hermes send --list` lists them. `MEDIA:<path>` in the text sends a file as an attachment.
- Cron delivery also knows `local` (keep output, send nothing) and `bot-chat[:profile]` (post into a profile's Bot Chat). Whether `hermes send` accepts `bot-chat` is unverified (R2.0).
- Kanban facts are in `docs/RUN-PLAN.md` §1. Still to verify in R2.0: `show/list --json` fields, idempotency replay, `archive` on a running task, and the `--parent` gating.

## Pieces

### 1. Run bundle (Canvas, shared code)

`src/graph/bundle.ts`, Node-free and pure. It compiles a frozen snapshot plus its preflight plan into `workflow-canvas.run-bundle` version 1: steps with key `wc:<runId>:<cardId>`, stage, assignee, skills, limits, `waitsFor`, branch requirements, decision values, deliveries (section 4), recorded approvals, and cancellation.

A step's body is composed from its card: title, description, instructions, acceptance criteria, and inputs/outputs, followed by a fixed footer. The footer says the step is part of a Workflow Canvas run and is not authorization to trade or move money. For a decision card it adds: report exactly one of the listed values as `metadata.branch`. For a step that feeds a delivery it adds: attach the result as a file. Card text reaches an agent only here, and only for cards that passed preflight.

### 2. Run state, approvals, reports (Canvas)

- `run_requests` gains `claimed_at`. A claimed request no longer expires.
- New tables: `run_approvals (run_id, card_id, decided_at, decision)` and `run_reports (run_id, received_at, payload)`.
- Derived status: requested → claimed → running → waiting for approval → completed / failed / stopped / cancelled / expired.
- Approve and Stop are UI actions. Until the login lands they are conventions, as already decided (R-D4), and the screen says so.

### 3. Connecting Hermes: pairing, not SSH keys

Forced-command SSH keys are too technical for "anyone". Instead:

1. In Canvas, **Connect Hermes** shows a one-time pairing code that is valid for 10 minutes.
2. On the Hermes machine the user runs the installer (section 5) with the Canvas address and that code. The installer exchanges the code for a **conductor token**: a long random secret, stored hashed in Canvas and in a mode-600 file on the Hermes side.
3. The token can call only `/api/conductor/*`: `GET pending`, `POST report/:runId`, and `PUT targets`. It cannot read or edit workflows, approve, request runs, or reach any other route. One token per connected Hermes; Canvas can revoke it.

Reachability: when Canvas and Hermes are on the same machine, the conductor talks to Canvas over loopback (the default). On different machines, the installer can open an SSH tunnel to the Canvas host; that is Dom's layout (Canvas VM, Hermes on the desk). A LAN bind waits for the login. The conductor routes need the token even on loopback, so no other local process can pose as the conductor.

### 4. Choosing where results go

- On connect, and then hourly, the conductor reports the harness's delivery targets: `hermes send --list`, plus `local`. Canvas stores a **label and an opaque id** per target (for example "Telegram · Briefings topic"). The real chat ids stay in the conductor's private file on the Hermes machine.
- **Deliver** is a new setting on artifact cards (schema 5): `deliverTo: <target id> | ""`. An artifact card marks an output, so delivering it means sending that output. The details panel offers the connected Hermes's targets, plus "Keep in Hermes only".
- Preflight refuses a delivery whose target id is not in the connected harness's current list, and a delivery artifact with no producing step before it.
- When the producing step completes, the **conductor**, not the agent, sends the attached result: `hermes send -t <real target> -s "<workflow> · <card>" -f <file>`. The runner profile therefore needs no messaging tools, and an agent cannot choose where output goes.
- The result text never passes through Canvas. Canvas sees only the outcome: delivered, failed, or skipped by branch (R-D5).

### 5. Installer and conductor (Hermes side)

`harness/hermes/workflow_canvas_conductor.py`, standard library only, run with `-I`, never importing Hermes. Subcommands:

- `install --canvas <url> --pair <code> [--tunnel user@host] [--dry-run]`. It prints every change first and asks before each one (`--yes` skips the prompts):
  - Create a **runner profile**, `canvas-runner`, with a minimal toolset: files and terminal in its task workspace, plus web search. No messaging, Kanban orchestration, MCP servers, or trading/payment tools.
  - Create a Kanban board, `workflow-canvas`.
  - Write the config (Canvas URL, token, board, allowed profiles = `canvas-runner`, allowed skills = none), mode 600.
  - Add a Hermes cron job, `every 1m`, `--no-agent`, `--deliver local`, that runs `tick`.
  - Report targets.
- `tick`: one pass. Pull bundles; refuse anything naming an unlisted profile or skill; read the run's tasks; create the steps now due with `hermes kanban --board workflow-canvas create --json --idempotency-key … --assignee … --skill … --parent … --max-retries 1 --max-runtime …m --workspace scratch --body-file …`; send due deliveries; archive on cancel or stop; report categories. The argv is always a list, never a shell string. It must finish well inside cron's 3-minute limit.
- `allow-profile <name>` / `allow-skill <name>`: widen the allowlist on purpose, for example to let an existing agent profile run a workflow after reviewing that profile's tools.
- `status`, and `uninstall` (removes the cron job, config, and token; leaves the board and its history).

The conductor only creates and archives tasks and sends deliveries. It never unblocks, completes, reassigns, or comments.

### 6. Run view (Canvas UI)

Per run: progress per stage, per-card badges labelled "reported by Kanban", per-delivery badges (sent / failed / skipped), and Approve, Stop, and Cancel. Badges stay in the run view; card readiness on the canvas is unchanged.

## Order of work

| Step | Work | Done when |
|---|---|---|
| **R2.0** | Verify Kanban and `hermes send` facts on a throwaway `HERMES_HOME` with no gateway: `send --list` format, `bot-chat` support, `send` to a test target in a throwaway home with no platform credentials (expect a clean failure), plus the Kanban items above. Confirm the desk's running gateway never sees the throwaway home. | Facts table added here |
| **R2.1** | Bundle compiler, run state, approvals, reports, pairing and conductor-token routes, schema 5 `deliverTo`, preflight delivery checks. Node tests. | Claim-once, expiry stops at claim, the token cannot reach any other route, a used or expired pairing code is refused, unknown target refused |
| **R2.2** | Conductor `tick` with a fake `hermes` (records argv, fake board), then against the real CLI and a throwaway home | §7 checks pass |
| **R2.3** | `install`, `uninstall`, `allow-*`, `status` against a throwaway home: dry-run output, each change, and clean removal | Install then uninstall leaves only the board; nothing outside the throwaway home changes |
| **R2.4** | Canvas UI: Connect Hermes, the Deliver picker, and the run view, with a browser test against fixture reports | Approve opens the next stage; delivery choices come only from reported targets |
| **R2.5** | Independent review, then docs, including a one-page "connect your Hermes" guide written for non-technical users | Review findings fixed or recorded |

## 7. Acceptance (R2 scope)

- **Idempotency.** Two ticks and a replayed bundle create each task once.
- **Gate.** Nothing behind an Approval card exists until Canvas records an approval. Board-side unblocking records nothing in Canvas.
- **Branches and joins.** Per branch value, plus missing, unrecognised, and multiple values. Untaken cards never appear; a join gets only existing parents.
- **Allowlist.** An unlisted profile or skill creates nothing and is reported.
- **Delivery.** The conductor sends exactly once per delivery, to the chosen target, only after its producer completes. An agent cannot change the target. In tests, `hermes send` is the fake; one real send happens only in R4.
- **Token scope.** The conductor token gets `401`/`403` on every non-conductor route. A replayed pairing code is refused.
- **Cancel, stop, restart.** Pending tasks are archived, nothing new is created, and a rerun after killing a tick makes no duplicates.
- **Privacy.** Result text, chat ids, task bodies, comments, summaries, and workspace paths never reach the Canvas database or logs.
- **No dispatch.** No gateway in the throwaway home; no worker is ever spawned.
- **Install hygiene.** Dry-run lists every change; uninstall removes the cron job, config, and token.

## 7a. Review findings to resolve before R2.2

A parallel planning session (`.hermes/plans/2026-10-31_131255-run-tracking-controlled-hermes-pilot.md`, untracked) reviewed this design. These findings are accepted as defects in the plan above:

1. **The conductor must trust only its own tasks.** Kanban workers get task-creation tools automatically. A worker could create a task with a later step's key, and a conductor that checks "a task with this key exists" would treat a gated step as done. Fix: the conductor keeps its own ledger of the task ids it created. A task under the run's key prefix that is not in that ledger is tampering; the run stops and the tampering is reported.
2. **A profile's tool list is not a security boundary.** A runner with terminal or file tools runs as the Hermes user and can read other profiles' credentials (including messaging bot tokens) and the conductor token. "No messaging tools" does not prevent sending. Fix, to verify in R2.0: run workers through an isolated terminal backend (container) with no access to the Hermes home, or give the runner no terminal or file tools at all. If neither holds on the installed release, the pilot is limited to tool-free steps.
3. **Reclaim can re-run an attempt.** `--max-retries 1` limits failure retries, not crash reclaim. Deliveries therefore need their own effect key, so the conductor sends each delivery at most once, checked against its ledger before `hermes send`.
4. **Run evidence must be durable.** The R1 request table keeps 20 rows per workflow and is deleted with the workflow. Run reports go in a separate append-only store that is never auto-pruned.

Unresolved conflicts with that plan (it requires a login before any pilot, evidence import and replay first, a one-shot adapter instead of Kanban, and no delivery) are put to Dom; see HANDOFF.

## 8. Decisions

Dom, 2026-10-31:

- **Results are delivered to a target the user picks** from what their Hermes can send to (chat, Telegram, other platforms, or local only). Section 4.
- **Anyone should be able to install, connect, and run with Hermes.** Pairing replaces SSH keys, and an installer creates a minimal runner profile. Sections 3 and 5.
- Dom delegated the technical R2 choices. Kirk's calls, recorded so they can be revisited:
  - Run outcomes reach Canvas through the conductor's own report call; Canvas never calls the harness for runs.
  - The default runner is a new minimal `canvas-runner` profile. Existing profiles (such as the one in Dom's practice copy) are allowed only explicitly, after a tools review.
  - Tests use throwaway Hermes homes on a machine with Hermes installed, plus a throwaway Canvas container. A fresh-machine install test belongs to release packaging (roadmap step 4).

Recording these is not approval to install anything on a real harness.
