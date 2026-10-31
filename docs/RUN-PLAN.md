# Running a workflow: design plan

Status: **plan only. Nothing is built, installed, or approved.** Roadmap step 7. Dom asked on 2026-10-31 to plan running before agent-assisted editing (`docs/AGENT-PROPOSALS.md`, paused). Every slice below needs its own go-ahead. This plan changes one line of the ownership table in `docs/HERMES-INTEGRATION.md` §1 (section 3) and needs agreement from that thread before any code.

Hard rules, unchanged by this plan:

- **Hermes executes. Canvas never does.** Canvas holds no credential that can start work on a harness.
- Every Approval card pauses the run until Dom approves it, and the pause is enforced by something an agent cannot satisfy (section 6).
- A run, a finished card, or an approval inside a run is **never** authorization to trade or move money. That needs Dom's explicit authorization outside Canvas. The pilot runs under a profile that has no trading or money tools at all (section 8).
- Drawing, accepting a proposal, or ticking a checklist still runs nothing. Only an explicit run request starts work (section 4).

## 1. Facts this plan rests on (Hermes Agent 0.22.5, checked 2026-10-31)

From the official Kanban docs (`/docs/user-guide/features/kanban`) and `hermes kanban --help` on this release:

| Fact | Consequence |
|---|---|
| Kanban tasks have parent → child links. The dispatcher promotes `todo → ready` only when every parent is `done` | `requires` arrows map directly onto parent links |
| `create` takes `--idempotency-key`; the same key returns the existing task | One task per (run, card), even if a request is replayed |
| `create` takes `--assignee`, `--skill`, `--max-retries`, `--max-runtime`, `--workspace`, `--body-file`, `--initial-status blocked`, `--json` | A card's executor, skills, and limits compile to flags. No shell is involved in the body |
| One `task_runs` row per attempt, with outcome (completed, blocked, crashed, timed out, spawn failed, reclaimed, gave up) | **Per-step evidence exists** for Kanban runs, unlike cron's whole-job result |
| Reclaiming a crashed worker "can re-execute effects the lost attempt already had" | Retries are not safe by default. The pilot sets `--max-retries 1` |
| Boards are isolated; workers see only their own board | A dedicated board for Canvas runs |
| **Any profile with the `kanban` toolset can `kanban_unblock`; workers can `kanban_create`; the board's REST routes skip auth for local processes** | A blocked Kanban card is **not** an approval gate. Section 6 designs around this |
| Kanban is single-host. The board and the dispatcher live on the harness | Canvas, on its own VM, can only *request* work. Something on the harness has to turn requests into tasks |
| `tasks.workflow_template_id` and `current_step_key` are reserved nullable columns for "v2 workflow routing" | Possible future tagging. Not used here, because no supported CLI flag writes them |
| Cron: schedules, `no_agent` scripts, 3-minute hard limit per run. Webhooks: HMAC-signed routes that start a run | Trigger plumbing already exists in Hermes (section 9) |

Not verified yet, and needed before slice R2: whether `hermes kanban show --json` (the flag exists) includes the idempotency key, whether `archive` closes a running attempt as `reclaimed` from the CLI as it does from the dashboard, and the exact flags for scheduled starts (`--scheduled-at` appears in the docs, not in `create --help`).

## 2. Three records, kept apart

| Record | Owner | Mutable? |
|---|---|---|
| **Workflow definition** (cards, arrows, brief) | Canvas | Yes, versioned by revision |
| **Run** (a frozen snapshot of one revision, plus requests and approvals) | Canvas | Append-only: requests, approvals, cancel |
| **Execution** (Kanban tasks and their attempts) | Hermes | Hermes only. Canvas observes |

A run pins `workflowId`, `revision`, and the SHA-256 of the definition at that revision. Editing the workflow afterwards never changes a run in flight. The run view always says which revision it is executing.

## 3. Ownership change, needs the integration thread

`docs/HERMES-INTEGRATION.md` §1 says: Dispatch, *Canvas role: None. No run, trigger, or resume route.* This plan changes that to:

> Dispatch: Hermes. **Canvas records a human's run request and approvals. A Hermes-side conductor decides whether to act on them.** Canvas still holds no harness credential that can create, run, or unblock work.

Nothing else in that table changes. Scheduling stays with Hermes cron; evidence stays observed, not edited.

## 4. Lifecycle of a run

```
Dom clicks "Request run" ─▶ Canvas: preflight on the pinned revision ─▶ run = requested
                                                                         │
                     harness conductor (Hermes cron, no agent) pulls ◀───┘ every minute
                                                                         │
       creates Kanban tasks for every card whose prerequisites are met ◀─┘
       (stops at each Approval card; nothing past it exists yet)
                                                                         │
          Dom approves the Approval card in Canvas ─▶ approval recorded ─▶ next pull creates the next stage
                                                                         │
          exporter reports task attempts ─▶ Canvas shows per-card evidence, labelled "reported by Kanban"
```

**Preflight** (pure function, testable now, slice R1). A run request is refused unless:

1. Every card that would execute is `configured`: approved and every setup check done. This is the first time readiness has a hard consequence.
2. No executing card has `inferred` or `assumption` set (the proposals design). A human has to clear those labels before the card's text becomes an agent's instructions.
3. Every executing card names an executor profile from the harness's private allowlist (section 8).
4. The graph uses only what the pilot supports: `requires` and `data` arrows, task, agent, integration and approval cards. A `conditional` arrow is refused with "branching is not supported in the pilot". `revision` arrows are explanatory and ignored. Note and artifact cards do not run.
5. No requires cycle (already guaranteed by the validator).

The preflight result is shown as a "What would run" panel: an ordered stage list, each card's executor and limits, and every refusal with the card it belongs to. That panel works with no harness connected.

**Compile, card → task:**

| Card | Kanban task |
|---|---|
| title | title |
| instructions + acceptance criteria + inputs/outputs | `--body-file` (written by the conductor, never through a shell) |
| executor profile | `--assignee` |
| skills (new card field, R1) | `--skill`, each checked against an allowlist |
| `requires` / `data` arrow | `--parent` |
| run id + card id | `--idempotency-key wc:<runId>:<cardId>` |
| pilot limits | `--max-retries 1 --max-runtime <card limit, default 30m> --workspace scratch` |
| Approval card | no task (section 6) |

## 5. Who creates the tasks: two options

**A. Conductor on the harness pulls (recommended).** A Hermes cron job with `no_agent=True` runs a small standard-library script every minute. It reaches Canvas over a forced-command SSH key on the Canvas VM, mirroring the evidence exporter in reverse: the key can only run `pending-runs` and `report <runId>`. It creates tasks with `hermes kanban create` using a fixed argument list. Canvas holds no harness write credential. Hermes decides, and Hermes's scheduler is the only thing that ever starts work. Cost: one more key, on the Canvas VM this time, and a cron job on the harness.

**B. Canvas pushes.** Canvas runs `instantiate <bundle>` over a second forced-command key on the harness. That is simpler, but Canvas then holds a credential that starts work, which contradicts §1 of the integration contract.

Either way, a conductor bug is serious. It stays tiny, deterministic, reviewed, and LLM-free, and it refuses anything outside the compiled bundle's schema.

## 6. Approval gates that an agent cannot satisfy

A blocked Kanban card can be unblocked by an agent (section 1), so it cannot be the gate. Instead, **nothing downstream of an Approval card exists until Dom approves it.** The conductor creates tasks stage by stage. It creates the stage after an Approval card only when Canvas reports an approval record for that run and that card.

The gate then rests on two things, stated plainly:

1. **Only Dom can write an approval record.** Today Canvas has no authentication, so any local process on the Canvas VM could post one. **Running therefore depends on the access token** (roadmap step 4), with a human-only `approve` scope that no agent key carries. Until that exists, slices R2+ stay on throwaway homes.
2. **The conductor is not an agent.** It is a fixed script with no model in the loop, so a prompt cannot talk it past a gate.

What this does **not** stop: an agent on that harness with Kanban tools can always create unrelated tasks of its own. The gate guarantees that *this workflow* does not continue without Dom. It does not limit what the agent's profile can already do, which is why section 8 limits the profile.

Approval UX: the Approval card shows "Waiting for you" with what the previous stage reported (category and attempt outcomes, section 7). There are two buttons, Approve and Stop run. A Telegram ping can come later as a Hermes delivery the conductor sends; the approval itself is still recorded in Canvas.

## 7. Evidence back into Canvas

The exporter (`harness/hermes/workflow_canvas_exporter.py`) gains `run <runId>`. It opens the run board's `kanban.db` with the same `immutable` and copy rules it uses for the cron store, selects tasks whose idempotency key starts with `wc:<runId>:`, and prints allowlisted fields: card id, status, attempt outcomes, timestamps, and exit kind.

Not exported, consistent with decision 4 of the integration contract: task bodies, comments, summaries, metadata, workspace paths, and error text. The panel shows categories ("completed", "blocked", "crashed after 1 attempt"). Whether to bring summaries across is decision R-D5.

**Readiness.** A card whose task completed in a run is shown with a separate badge, "Ran OK in run #3 (rev 12)", next to its design readiness. The server still refuses `tested` and `operational` as edits. Deriving them from observed runs, and with what rule, is a later decision. One completed run is not qualification.

## 8. Execution boundaries

- **Dedicated board** for Canvas runs (for example `workflow-canvas`). Workers see only that board.
- **Executor allowlist**, private per harness: the profile names a run may assign. The pilot allowlist holds exactly one profile, a new runner profile with a minimal toolset (files, terminal in its scratch workspace, no messaging delivery, **no brokerage, exchange, payment, or other trading or money tools**, no Kanban orchestration toolset). That profile's limits are what actually bound a run. A card saying "do not trade" is not a control.
- **Skill allowlist**, private per harness, checked by the conductor.
- **No retries** in the pilot (`--max-retries 1`). A failed card blocks the run and Dom decides.
- **Cancel** (Stop run) records a cancel request. The conductor archives every not-yet-done task with the run's key prefix and creates nothing more. A running attempt may finish its current turn. The panel says so rather than claiming an instant stop.
- **Duplicates**: one run per request id; one task per (run, card) through the idempotency key. A replayed or concurrent pull cannot double-create.
- **Restart**: the conductor keeps no state. Each pull reconciles Canvas run records against the Kanban tasks that exist. A Canvas or harness restart resumes from the records.

## 9. Triggers, after the pilot

Recorded intent (HANDOFF 2026-10-30): schedule, Telegram message, webhook, another workflow finishing, market condition. All of them map onto Hermes features, and all of them go through the same run-request record and preflight, so a trigger is never a back door around approval:

| Trigger | Hermes mechanism | What it does |
|---|---|---|
| Schedule | a cron job (`no_agent`) | Posts a run request, keyed by the scheduled instant, so a catch-up cannot double-run |
| Webhook | `hermes webhook subscribe` with HMAC | Same, keyed by delivery id |
| Workflow finished | the conductor, on the parent run's completion | Same |
| Telegram message | gateway command | Same; design later |
| Market condition | a cron script that checks a condition | Same. Never trades; the run it requests is a design workflow under the runner profile |

Canvas does not install these. For each trigger it generates the exact `hermes cron add …` / `hermes webhook subscribe …` text for Dom to review and run. Having Canvas write them would be a second scheduler.

## 10. Slices

| Slice | What | Touches Hermes? |
|---|---|---|
| **R1** | Run record, preflight, "What would run" panel, executor and skills fields on cards, frozen snapshot. No conductor, no harness | No |
| **R2** | Conductor script and `run` exporter subcommand, tested against **throwaway Hermes homes** with a throwaway board. Dispatch is checked with `hermes kanban dispatch --dry-run` | Throwaway only |
| **R3** | Access token with `approve` scope (shares roadmap step 4) | No |
| **R4** | Pilot on the real harness: one non-financial, local-output workflow, manual start, one Approval card, the runner profile, no retries. Needs separate approval for the profile, board, keys, and cron job | **Yes, approved separately** |
| **R5** | Triggers, one kind at a time | Yes, each approved |

## 11. Acceptance checks (R1–R4)

- **Preflight**: refuses a proposed card, an unfinished setup check, an Assumption card, an unknown profile, a conditional arrow, and an unknown skill. Each refusal names its card. A clean graph lists stages in dependency order.
- **Frozen revision**: edit the workflow after requesting a run; the run still compiles revision N with the same digest.
- **Idempotency**: two pulls and a replayed request create each task exactly once (count tasks per key prefix).
- **Gate**: nothing downstream of an Approval card exists on the board until an approval is recorded. Unblocking or creating tasks by hand does not make Canvas record an approval. Approval without the `approve` scope is refused (R3).
- **No money path**: the runner profile's resolved toolset contains no trading, payment, or messaging-delivery tool (`hermes -p <runner> tools list`, recorded).
- **Cancel**: Stop run archives all pending tasks for the run and creates no new ones. A running attempt is shown as "finishing current attempt".
- **Failure**: crashed, timed out, blocked, and gave up each show as their own category. None is shown as success. The run stops at the first failure.
- **Restart**: restart Canvas and the harness gateway mid-run; the next pull reconciles without duplicates.
- **Evidence privacy**: a fixture task with a known body, comment, summary, and workspace path; none of those strings appears in exporter output, the Canvas database, or Canvas logs.
- **Before/after on the real harness (R4)**: board task counts, cron list, and no new listeners, recorded before and after.

## 12. Decisions needed

- **R-D1.** Conductor on the harness pulls (A, recommended) or Canvas pushes (B)?
- **R-D2.** Per-card executor: HANDOFF records "a Hermes agent or a script the canvas runs itself"; the roadmap later superseded the Canvas-run script. Confirm **Hermes only**: a script card runs as a Kanban worker or a Hermes `no_agent` cron script, never inside Canvas.
- **R-D3.** Pilot workflow: which non-financial, local-output workflow? It should be one Dom actually wants, with one Approval card.
- **R-D4.** Running waits for the access token (R3) before touching the real harness. Recommended: yes.
- **R-D5.** Bring worker summaries back into Canvas, or categories only, as for cron error detail?
- **R-D6.** Conditional branches: refused in the pilot (recommended), or the source card's worker chooses a branch and the conductor archives the other?

Recording a decision is not approval to build or install anything.
