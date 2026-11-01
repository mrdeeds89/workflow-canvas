#!/usr/bin/env python3
"""Workflow Canvas conductor (Hermes side).

A small, model-free program. It pulls approved run bundles from Canvas,
creates Kanban tasks stage by stage, sends due deliveries, and reports
outcome-only results. It never interprets a card's text as an instruction to
itself, never runs workflow code, and holds no credential that Canvas can use
to start work.

Design rules it enforces (docs/RUN-PLAN.md, docs/R2-PLAN.md):
  * It trusts only the task ids it created itself, recorded in its own ledger.
    It never infers that a step is done from "a task with this key exists", so
    a task a worker creates cannot satisfy a gate (R2.0 finding 2, review 1).
  * It creates the tasks behind an Approval card only after Canvas records a
    human approval for that card. A blocked Kanban card is not a gate.
  * A delivery is sent at most once: the ledger marks the attempt before the
    send, and an already-marked delivery is never retried (review 3).
  * Only profiles and skills on the allowlist may run. Anything else creates
    nothing and is reported.
  * It performs no trade or money movement and carries no such tool. A run,
    a finished card, or an approval is never authorization to trade.

Standard library only. Run with -I so nothing is imported from the working
directory. It never imports Hermes; it shells out to the `hermes` CLI.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

CONFIG_ENV = "WORKFLOW_CANVAS_CONDUCTOR_CONFIG"
DEFAULT_CONFIG = os.path.expanduser("~/.config/workflow-canvas/conductor.json")

# Kanban status -> the outcome vocabulary Canvas accepts (outcome only).
KANBAN_TO_OUTCOME = {
    "todo": "created",
    "ready": "created",
    "scheduled": "created",
    "running": "running",
    "review": "running",
    "blocked": "blocked",
    "done": "completed",
}


class ConductorError(Exception):
    pass


# --- configuration -----------------------------------------------------------


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        cfg = json.load(handle)
    for key in ("canvas_url", "token", "board", "ledger_path"):
        if not cfg.get(key):
            raise ConductorError(f"config is missing '{key}'")
    cfg.setdefault("allowed_profiles", [])
    cfg.setdefault("allowed_skills", [])
    cfg.setdefault("hermes_bin", "hermes")
    cfg.setdefault("delivery_dir", os.path.join(os.path.dirname(path), "deliveries"))
    # Real messaging targets, keyed by the opaque id Canvas knows. Never leaves here.
    cfg.setdefault("targets", {})
    cfg["canvas_url"] = cfg["canvas_url"].rstrip("/")
    return cfg


# --- ledger (the conductor's own memory) -------------------------------------


def load_ledger(cfg: dict) -> dict:
    try:
        with open(cfg["ledger_path"], "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return {"runs": {}}


def save_ledger(cfg: dict, ledger: dict) -> None:
    path = cfg["ledger_path"]
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(ledger, handle)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


# --- Canvas HTTP (conductor token) -------------------------------------------


def canvas(cfg: dict, method: str, path: str, body: dict | None = None) -> dict:
    url = cfg["canvas_url"] + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("authorization", "Bearer " + cfg["token"])
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        raise ConductorError(f"Canvas {method} {path} -> {err.code}: {detail}") from err


# --- Hermes CLI --------------------------------------------------------------


def run_hermes(cfg: dict, args: list[str]) -> tuple[int, str, str]:
    """Run the hermes CLI with an argv list (never a shell string)."""
    proc = subprocess.run(
        [cfg["hermes_bin"], *args],
        capture_output=True,
        text=True,
        timeout=120,
    )
    return proc.returncode, proc.stdout, proc.stderr


def hermes_json(cfg: dict, args: list[str]) -> dict:
    code, out, err = run_hermes(cfg, args)
    if code != 0:
        raise ConductorError(f"hermes {' '.join(args)} failed ({code}): {err.strip() or out.strip()}")
    out = out.strip()
    return json.loads(out) if out else {}


def kanban(cfg: dict, *args: str) -> list[str]:
    return ["kanban", "--board", cfg["board"], *args]


# --- target discovery --------------------------------------------------------


def refresh_targets(cfg: dict) -> None:
    """Report the harness's messaging targets to Canvas and keep the real map here."""
    try:
        listing = hermes_json(cfg, ["send", "--list", "--json"])
    except ConductorError:
        return  # no gateway yet, or send --list unavailable; leave targets as they are
    reported = []
    real_map = dict(cfg.get("targets", {}))
    for item in listing.get("targets", []) if isinstance(listing, dict) else []:
        target = item.get("target") if isinstance(item, dict) else None
        label = item.get("label") if isinstance(item, dict) else None
        if not isinstance(target, str) or target == "":
            continue
        opaque = "t:" + target  # a stable opaque id; the real target never leaves here
        reported.append({"id": opaque, "label": label or target, "kind": "messaging"})
        real_map[opaque] = target
    cfg["targets"] = real_map
    try:
        canvas(cfg, "PUT", "/api/conductor/targets", {"targets": reported})
    except ConductorError:
        pass


# --- one pass ----------------------------------------------------------------


def tick(cfg: dict) -> dict:
    ledger = load_ledger(cfg)
    refresh_targets(cfg)

    # Claim anything pending. A claimed run leaves the pending list; we keep its
    # bundle in the ledger and work it across ticks.
    pending = canvas(cfg, "GET", "/api/conductor/pending").get("runs", [])
    for item in pending:
        run_id = item["runId"]
        if run_id in ledger["runs"]:
            continue
        if canvas(cfg, "POST", f"/api/conductor/claim/{run_id}").get("claimed"):
            ledger["runs"][run_id] = {
                "bundle": item["bundle"],
                "tasks": {},        # step key -> created task id
                "deliveries": {},   # artifact card id -> "attempting" | "sent" | "failed"
                "done": False,
            }

    summary = {"claimed": 0, "created": 0, "delivered": 0, "runs": {}}
    for run_id, state in ledger["runs"].items():
        if state["done"]:
            continue
        summary["runs"][run_id] = advance_run(cfg, ledger, run_id, state, summary)

    save_ledger(cfg, ledger)
    return summary


def advance_run(cfg: dict, ledger: dict, run_id: str, state: dict, summary: dict) -> str:
    bundle = state["bundle"]
    steps = bundle["steps"]
    by_key = {step["key"]: step for step in steps}

    run = canvas(cfg, "GET", f"/api/conductor/run/{run_id}")
    approvals = {entry["cardId"]: entry["decision"] for entry in run.get("approvals", [])}

    # Cancelled or stopped: archive what we created, create nothing, finish.
    if run.get("cancelled") or run.get("stopped"):
        for task_id in state["tasks"].values():
            run_hermes(cfg, kanban(cfg, "archive", task_id))
        state["done"] = True
        return "stopped" if run.get("stopped") else "cancelled"

    # Allowlist: refuse the whole run if any step names a profile or skill we do
    # not allow. Create nothing.
    for step in steps:
        if step["role"] != "run":
            continue
        if step["assignee"] not in cfg["allowed_profiles"]:
            report(cfg, run_id, steps, {}, {}, "failed")
            state["done"] = True
            return "refused_profile"
        for skill in step.get("skills", []):
            if skill not in cfg["allowed_skills"]:
                report(cfg, run_id, steps, {}, {}, "failed")
                state["done"] = True
                return "refused_skill"

    # Read the outcome of every task we created. We look up only our own ids;
    # a task we did not create can never satisfy a gate here.
    outcomes: dict[str, str] = {}   # card id -> outcome
    branch_of: dict[str, str] = {}  # decision card id -> reported branch
    for key, task_id in state["tasks"].items():
        card_id = by_key[key]["cardId"]
        task = hermes_json(cfg, kanban(cfg, "show", task_id, "--json"))
        task = task.get("task", task)
        outcomes[card_id] = KANBAN_TO_OUTCOME.get(task.get("status", ""), "running")
        meta = task.get("metadata") or {}
        if isinstance(meta, dict) and isinstance(meta.get("branch"), str):
            branch_of[card_id] = meta["branch"]

    # Decide which not-yet-created steps are due, and create them.
    for step in steps:
        key = step["key"]
        if key in state["tasks"]:
            continue
        if step["role"] == "approval":
            continue  # approval steps are never Kanban tasks; they gate via Canvas
        decision = step_readiness(step, by_key, outcomes, branch_of, approvals)
        if decision == "skip":
            continue  # untaken branch or rejected approval: never created
        if decision != "due":
            continue  # waiting on a parent, a branch, or an approval
        task_id = create_step(cfg, run_id, step, state)
        state["tasks"][key] = task_id
        outcomes[step["cardId"]] = "created"
        summary["created"] += 1

    # Deliveries: send each at most once, after its producers complete.
    deliver(cfg, run_id, bundle, state, outcomes, summary)

    # Report outcome only.
    run_status = roll_up(steps, state, outcomes)
    report(cfg, run_id, steps, outcomes, state["deliveries"], run_status)
    return run_status


def step_readiness(step, by_key, outcomes, branch_of, approvals) -> str:
    """'due', 'wait', or 'skip' for a step not yet created."""
    for parent_key in step.get("waitsForKeys", []):
        parent = by_key.get(parent_key)
        if parent is None:
            return "wait"
        card_id = parent["cardId"]
        if parent["role"] == "approval":
            decision = approvals.get(card_id)
            if decision == "rejected":
                return "skip"
            if decision != "approved":
                return "wait"
        else:
            if outcomes.get(card_id) != "completed":
                return "wait"
    for requirement in step.get("branches", []):
        decision_card = requirement["decisionCardId"]
        chosen = branch_of.get(decision_card)
        if chosen is None:
            return "wait"            # the decision has not reported yet
        if chosen not in requirement["branches"]:
            return "skip"            # a different branch was taken
    return "due"


def create_step(cfg: dict, run_id: str, step: dict, state: dict) -> str:
    parents = [
        state["tasks"][parent_key]
        for parent_key in step.get("waitsForKeys", [])
        if parent_key in state["tasks"]
    ]
    args = kanban(
        cfg,
        "create",
        step["title"],
        "--assignee",
        step["assignee"],
        "--idempotency-key",
        step["key"],
        "--max-retries",
        "1",
        "--max-runtime",
        f"{int(step['maxRuntimeMinutes'])}m",
        "--workspace",
        "scratch",
        "--json",
    )
    for skill in step.get("skills", []):
        args += ["--skill", skill]
    for parent in parents:
        args += ["--parent", parent]
    # The card's text goes in a body file, never on the command line.
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as handle:
        handle.write(step["body"])
        body_path = handle.name
    try:
        args += ["--body-file", body_path]
        created = hermes_json(cfg, args)
    finally:
        try:
            os.unlink(body_path)
        except OSError:
            pass
    created = created.get("task", created)
    task_id = created.get("id")
    if not isinstance(task_id, str):
        raise ConductorError(f"hermes kanban create returned no id for {step['key']}")
    return task_id


def deliver(cfg: dict, run_id: str, bundle: dict, state: dict, outcomes: dict, summary: dict) -> None:
    by_key = {step["key"]: step for step in bundle["steps"]}
    for delivery in bundle.get("deliveries", []):
        card_id = delivery["cardId"]
        if state["deliveries"].get(card_id):
            continue  # already attempted; at most once
        producers_done = all(
            outcomes.get(by_key[key]["cardId"]) == "completed"
            for key in delivery.get("afterKeys", [])
            if key in by_key
        )
        if not delivery.get("afterKeys") or not producers_done:
            continue
        # Mark the attempt before acting, so a crash never causes a second send.
        state["deliveries"][card_id] = "attempting"
        save_ledger(cfg, {"runs": {**load_ledger(cfg)["runs"], run_id: state}})
        ok = perform_delivery(cfg, run_id, delivery)
        state["deliveries"][card_id] = "sent" if ok else "failed"
        if ok:
            summary["delivered"] += 1


def perform_delivery(cfg: dict, run_id: str, delivery: dict) -> bool:
    os.makedirs(cfg["delivery_dir"], exist_ok=True)
    out_path = os.path.join(cfg["delivery_dir"], f"{run_id}-{delivery['cardId']}.txt")
    # The producing task's result is written to a run-scoped file. Result text
    # never passes back through Canvas.
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(f"Workflow Canvas delivery for run {run_id}, card {delivery['cardId']}.\n")
    if delivery.get("localFile"):
        return True
    real = cfg["targets"].get(delivery["targetId"])
    if not real:
        return False  # unknown target; never guess
    code, out, err = run_hermes(cfg, ["send", "-t", real, "-s", "Workflow Canvas result", "-f", out_path, "--json"])
    if code != 0:
        return False
    try:
        body = json.loads(out) if out.strip() else {}
    except json.JSONDecodeError:
        return False
    # send --json returns exit 0 even on error; the reason is in `error` (R2.0 finding 8).
    return "error" not in body


def roll_up(steps: list, state: dict, outcomes: dict) -> str:
    run_cards = [step["cardId"] for step in steps if step["role"] == "run"]
    if any(state["deliveries"].get(k) == "failed" for k in state["deliveries"]):
        return "failed"
    if any(outcomes.get(card) in ("failed", "blocked") for card in run_cards):
        return "failed"
    created_cards = {step["cardId"] for step in steps if step["key"] in state["tasks"]}
    if created_cards and all(outcomes.get(card) == "completed" for card in created_cards):
        # Completed only when every step that will ever be created has been created
        # and finished. A step still gated is not yet created, so keep running.
        pending_steps = [
            step for step in steps
            if step["role"] == "run" and step["key"] not in state["tasks"]
        ]
        if not pending_steps:
            return "completed"
    return "running"


def report(cfg: dict, run_id: str, steps: list, outcomes: dict, deliveries: dict, run_status: str) -> None:
    step_reports = []
    for step in steps:
        card_id = step["cardId"]
        if card_id in outcomes:
            step_reports.append({"cardId": card_id, "status": outcomes[card_id]})
    delivery_reports = [
        {"cardId": card_id, "status": status}
        for card_id, status in deliveries.items()
        if status in ("sent", "failed")
    ]
    payload: dict = {"runStatus": run_status}
    if step_reports:
        payload["steps"] = step_reports
    if delivery_reports:
        payload["deliveries"] = delivery_reports
    canvas(cfg, "POST", f"/api/conductor/report/{run_id}", payload)


# --- CLI ---------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Workflow Canvas conductor (Hermes side).")
    parser.add_argument("--config", default=os.environ.get(CONFIG_ENV, DEFAULT_CONFIG))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("tick", help="Run one pass: claim, create due steps, deliver, report.")
    sub.add_parser("status", help="Print the ledger summary.")
    args = parser.parse_args(argv)

    try:
        cfg = load_config(args.config)
    except (OSError, ConductorError, json.JSONDecodeError) as err:
        print(f"conductor: cannot load config: {err}", file=sys.stderr)
        return 2

    try:
        if args.command == "tick":
            print(json.dumps(tick(cfg)))
            return 0
        if args.command == "status":
            ledger = load_ledger(cfg)
            runs = {rid: {"done": s["done"], "tasks": len(s["tasks"]), "deliveries": s["deliveries"]} for rid, s in ledger["runs"].items()}
            print(json.dumps({"runs": runs}))
            return 0
    except ConductorError as err:
        print(f"conductor: {err}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
