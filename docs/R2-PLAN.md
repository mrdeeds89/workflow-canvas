# R2 plan: conductor and run evidence (throwaway Hermes homes only)

Status: **plan, not built.** Slice R2 of `docs/RUN-PLAN.md`. Every step here runs against throwaway Hermes homes and throwaway boards. Installing anything on a real harness (a key, a cron job, a board, a runner profile) is R4 and needs its own go-ahead. Read `docs/RUN-PLAN.md` first: pull (R-D1), Hermes-only executors, outcome-only evidence, and branches with joins are decided.

## Goal

A request recorded in Canvas (R1) becomes Kanban tasks on a Hermes board, created stage by stage by a deterministic conductor that never involves a model. Outcomes come back to Canvas as allowlisted categories. Approval cards hold the next stage until a person approves in Canvas. All of it is exercised end to end with a real `hermes kanban` CLI pointed at a throwaway `HERMES_HOME`, with no gateway, so nothing is ever dispatched to a worker.

## Pieces

### 1. Run bundle (Canvas, shared code)

`src/graph/bundle.ts`, Node-free and pure. It compiles a frozen snapshot plus its preflight plan into `workflow-canvas.run-bundle` version 1:

```jsonc
{
  "format": "workflow-canvas.run-bundle", "version": 1,
  "runId": "…", "workflowId": "…", "revision": 7, "digest": "sha256 of snapshot",
  "steps": [{
    "cardId": "…", "key": "wc:<runId>:<cardId>", "role": "run" | "approval",
    "stage": 0, "title": "…", "body": "…",            // body composed below
    "assignee": "profile", "skills": ["…"], "maxRuntimeMinutes": 30,
    "waitsFor": ["cardId"], "branches": [{ "decisionCardId": "…", "branches": ["…"] }],
    "decides": ["pass", "fail"]
  }],
  "approvals": [{ "cardId": "…", "approvedAt": 0 }],   // from Canvas records
  "cancelled": false
}
```

The body is composed from the card: its title, description, instructions, acceptance criteria, and inputs/outputs, followed by a fixed footer. The footer says the step is part of a Workflow Canvas run and is not authorization to trade or move money. For a decision card it adds: report exactly one of the listed values as `metadata.branch` in `kanban_complete`. Card text reaches an agent only here, and only for cards that passed preflight (configured, not Inferred).

### 2. Canvas run state and approvals

- `run_requests` gains `claimed_at`. A request that has been claimed no longer expires.
- New table `run_approvals (run_id, card_id, approved_at, stopped)`.
- New table `run_reports (run_id, received_at, payload)`, keeping the latest per run plus the last 20.
- Derived run status: requested → claimed → running → waiting for approval → completed / failed / stopped / cancelled / expired.
- Routes: `POST /api/workflows/:id/runs/:runId/approvals/:cardId` (approve) and `…/stop`. With no login these are UI conventions (R-D4). The plan says so on screen.

### 3. Feed command (Canvas VM, forced command)

`scripts/canvas-feed.ts`, run by a forced-command SSH key on the Canvas VM. It takes no shell and fixed subcommands only:

- `pending <harnessLabel>`: bundles for open or claimed runs that are not finished. Claiming happens here, in one transaction: the first `pending` that returns a run sets `claimed_at`.
- `report <runId>`: reads one JSON observation on stdin (cap 64 KB), validates it against an allowlist (card id, status category, attempt outcomes, timestamps, branch value from the card's own list), and stores it.

It refuses anything else and writes nothing but those rows. Tests spawn it the way sshd would, through `SSH_ORIGINAL_COMMAND`.

### 4. Conductor (harness side)

`harness/hermes/workflow_canvas_conductor.py`: standard library only, run with `-I`, never importing Hermes. A Hermes cron job with `no_agent` would run it every minute in R4. Hermes cron's 3-minute limit per run means a tick must stay short. Each tick:

1. Pull bundles over SSH, with a fixed argv and the forced-command key.
2. Load the private config: Canvas host label, board slug, allowed profiles, allowed skills, and limits. Refuse any bundle naming something outside it, and report the refusal.
3. Read the board's current tasks for the key prefix `wc:<runId>:`. Reads open `kanban.db` with the exporter's `immutable` rule, or `hermes kanban list --json` if that is enough (R2.0 decides).
4. Create every step that is now due: its stage gates are met (approvals recorded, branch chosen), its branch requirement holds, and it has no task yet. Use `hermes kanban --board <slug> create --json --idempotency-key <key> --assignee … --skill … --parent <existing parent task ids> --max-retries 1 --max-runtime <n>m --workspace scratch --created-by workflow-canvas --body-file <private temp file>`. The argv is built as a list, never as a shell string.
5. On cancel or stop: `hermes kanban archive` every task under the run's prefix that is not yet done. Report "stopping" while an attempt is still running.
6. Report status categories for every task back through `report`.

The conductor never unblocks, completes, reassigns, or comments on a task. It only creates and archives.

### 5. Canvas run view (UI)

On each run in "What would run": progress per stage, and a per-card badge labelled "reported by Kanban" (completed, blocked, crashed, timed out, gave up, skipped by branch). Waiting approvals get Approve and Stop buttons, plus Cancel run. Badges belong to the run view only. Card readiness on the canvas is unchanged.

## Order of work

| Step | Work | Done when |
|---|---|---|
| **R2.0** | Verify Kanban facts on a throwaway `HERMES_HOME` (desk, Hermes 0.22.5, no gateway): board create, `create --json` output, idempotency replay, `--parent` gating, `show/list --json` fields (is the idempotency key visible?), `archive` on ready and running tasks, `dispatch --dry-run`. Confirm the desk's running gateway never sees the throwaway home. | A short facts table in this file, with real command output kept privately |
| **R2.1** | Bundle compiler, run state, approval and report tables, feed command, all with Node tests | Tests cover claim-once, expiry stopping at claim, refusal of unknown subcommands, report allowlisting, and approval gating |
| **R2.2** | Conductor, unit-tested with a fake `hermes` that records argv and a fake board; then an integration run on the desk against the real CLI and a throwaway home | Every RUN-PLAN §11 check that applies passes (below) |
| **R2.3** | Run view UI plus a browser test against fixture reports | Approve opens the next stage; Stop and Cancel show their states; badges come only from reports |
| **R2.4** | Independent review of the patch, then docs | Review findings fixed or recorded |

## Acceptance (from RUN-PLAN §11, R2 scope)

- **Idempotency.** Two ticks and a replayed bundle create each task exactly once. Count tasks per key prefix on the throwaway board.
- **Gate.** Nothing behind an Approval card exists on the board until Canvas records an approval. Unblocking or creating tasks by hand on the board records no approval in Canvas.
- **Branches.** A fixture for each branch value, plus missing, unrecognised, and multiple values. Each creates only its own cards; untaken cards never appear on the board; a join is created with only the parents that exist.
- **Allowlist.** A bundle naming an unlisted profile or skill creates nothing and reports a refusal.
- **Cancel and stop.** Pending tasks are archived and nothing new is created.
- **Restart.** Kill the conductor mid-tick, then rerun: no duplicates.
- **Privacy.** A fixture task with a known body, comment, summary, and workspace path: none of those strings appears in the report, the Canvas database, or logs.
- **No dispatch.** Throughout, the throwaway home has no gateway, `dispatch --dry-run` is the only dispatcher call, and no worker process is ever spawned.

## Open decisions for Dom

1. **Evidence path.** The conductor reports each tick over the same key (recommended: one key, one direction of trust, no Canvas-initiated call), or the existing exporter gains `run <runId>` and Canvas pulls.
2. **Pilot runner profile.** The plan calls for a dedicated runner profile with a minimal toolset. The practice copy names an existing agent profile, which has no MCP servers configured (checked 2026-10-31), but its full toolset has not been reviewed. Either review that profile's tools in R2.0 or create a dedicated runner in R4.
3. **Where tests run.** Node tests run in the pinned image on the project VM. The real-CLI integration needs Hermes, which is on the desk, not the VM. Recommended: run R2.2's integration on the desk against a throwaway home, with Canvas's feed exercised through a throwaway Canvas container on the VM.

Recording these is not approval to install anything on a harness.
