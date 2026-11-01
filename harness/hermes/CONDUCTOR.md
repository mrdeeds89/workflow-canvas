# Workflow Canvas conductor (Hermes side)

The **conductor** is a small, model-free program that runs on a Hermes machine,
pulls approved run bundles from Workflow Canvas, creates Kanban tasks stage by
stage, sends due deliveries, and reports outcomes. It is separate from the
read-only exporter documented in `README.md`.

Canvas never executes anything. The conductor does, and only within strict
limits. A run, a finished card, or an approval is **never** authorization to
trade or move money.

## Files

- `workflow_canvas_conductor.py` — the conductor. Standard library only; run it
  with `python3 -I`. It never imports Hermes; it shells out to the `hermes` CLI.
- `tests/` — hermetic tests (a Python stub Canvas and `fake_hermes.py`), plus
  one gated real-CLI test. The default tests touch no real Hermes, board,
  profile or cron.

## What it enforces

- It trusts only the task ids it created itself (its own ledger). A task a
  worker creates cannot satisfy a gate.
- It creates the steps behind an Approval card only after Canvas records a
  **human** approval. A blocked Kanban card is not a gate.
- An untaken branch and a rejected approval never create downstream steps.
- Only allow-listed profiles and skills may run; anything else creates nothing
  and reports failed.
- Each delivery is sent at most once. A local-file delivery writes a file; a
  messaging delivery resolves the opaque target id to the real target the
  conductor holds privately. Result text never passes back through Canvas.
- Canvas only ever sees an opaque `HMAC(local secret, target)` id and a
  platform-only label; the real chat/channel id stays in the 0600 config.
- A joined step runs once any live branch reaches it; dead branches are ignored.
  A decision that finishes without reporting one of its listed branches stops the
  run rather than guessing.
- Idempotency keys are unguessable (`HMAC(secret, step key)`) and a returned id
  already in the ledger is refused as possible tampering.
- One tick runs at a time (an exclusive lock) and the ledger is saved around every
  claim, create and send, so a crash or overlap cannot double-send or lose a run.

Safety still deferred to later rounds (see `docs/R2-PLAN.md` §7b): approve,
connect and pair need no human credential yet — that is **R3**, a hard
prerequisite for any real run (**R4**), where the runner also gets a strict tool
allowlist verified against `~/.hermes/.env`. Until then this is a trusted-network
pilot behind a tunnel that exposes only `/api/conductor/*`.

## Commands

    # One pass (what the cron job runs):
    python3 -I workflow_canvas_conductor.py --config <path> tick

    # Connect this Hermes to Canvas and set everything up (asks before each change):
    python3 -I workflow_canvas_conductor.py --config <path> install \
        --canvas http://127.0.0.1:8787 --pair <code-from-canvas>
    #   add --dry-run to preview, --yes to skip prompts

    python3 -I workflow_canvas_conductor.py --config <path> allow-profile <name>
    python3 -I workflow_canvas_conductor.py --config <path> allow-skill <name>
    python3 -I workflow_canvas_conductor.py --config <path> status
    python3 -I workflow_canvas_conductor.py --config <path> uninstall

`install` creates a minimal runner profile, a **dedicated** Kanban board (a
named board is the only real isolation — `--board` overrides `HERMES_KANBAN_DB`
and `HERMES_HOME` does not redirect the Kanban home), a mode-600 config, a tick
wrapper, and an every-1-minute `--no-agent --deliver local` cron job.

## Status

Pilot design. Installing on a real Hermes host is a later, separately-approved
step (R4). Until then run only the tests:

    python3 -I tests/test_conductor.py
    python3 -I tests/test_installer.py
    WC_REAL_HERMES=1 python3 -I tests/test_conductor_real.py   # needs a real hermes CLI

See `../../docs/R2-PLAN.md` and `../../docs/RUN-PLAN.md` for the full design.
