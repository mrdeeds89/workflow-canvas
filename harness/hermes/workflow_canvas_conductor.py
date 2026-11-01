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
import fcntl
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
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
    cfg.setdefault("targets", {})  # opaque id -> real messaging target (local only, never sent to Canvas)
    cfg["canvas_url"] = cfg["canvas_url"].rstrip("/")
    cfg["_path"] = path
    if not cfg.get("secret"):
        # A local secret so idempotency keys and target ids are unguessable.
        cfg["secret"] = secrets.token_hex(32)
        save_config(cfg)
    return cfg


def save_config(cfg: dict) -> None:
    path = cfg.get("_path")
    if not path:
        return
    out = {k: v for k, v in cfg.items() if k != "_path"}
    write_private(path, json.dumps(out, indent=2))


def target_id(cfg: dict, real_target: str) -> str:
    """An opaque, stable id for a real target. The real target never leaves here."""
    digest = hmac.new(cfg["secret"].encode(), real_target.encode(), hashlib.sha256).hexdigest()
    return "t:" + digest[:16]


# --- ledger (the conductor's own memory) -------------------------------------


def load_ledger(cfg: dict) -> dict:
    try:
        with open(cfg["ledger_path"], "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return {"runs": {}}


def save_ledger(cfg: dict, ledger: dict) -> None:
    path = cfg["ledger_path"]
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    try:
        os.write(fd, json.dumps(ledger).encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)
    dfd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


# --- Canvas HTTP (conductor token) -------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - never follow a redirect with the token
        raise ConductorError("Canvas attempted a redirect; refusing to resend the token.")


_OPENER = urllib.request.build_opener(_NoRedirect)


def canvas(cfg: dict, method: str, path: str, body: dict | None = None) -> dict:
    url = cfg["canvas_url"] + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("authorization", "Bearer " + cfg["token"])
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with _OPENER.open(req, timeout=30) as resp:
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
        opaque = target_id(cfg, target)
        real_map[opaque] = target  # local only, never sent to Canvas
        # The real target must never be the visible label either.
        shown = label if isinstance(label, str) and label and label != target else safe_label(target)
        reported.append({"id": opaque, "label": shown, "kind": "messaging"})
    cfg["targets"] = real_map
    save_config(cfg)
    try:
        canvas(cfg, "PUT", "/api/conductor/targets", {"targets": reported})
    except ConductorError:
        pass


def safe_label(target: str) -> str:
    """A human label that reveals the platform but not the chat/channel id."""
    platform = target.split(":", 1)[0] or "message"
    tag = hashlib.sha256(target.encode()).hexdigest()[:4]
    return f"{platform} · {tag}"


# --- one pass ----------------------------------------------------------------


TICK_DEADLINE_S = 110  # finish well inside cron's 3-minute kill


def tick(cfg: dict) -> dict:
    # One tick at a time: a lock stops two overlapping ticks double-sending.
    lock_path = cfg["ledger_path"] + ".lock"
    os.makedirs(os.path.dirname(lock_path) or ".", exist_ok=True)
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(lock_fd)
        return {"skipped": "another tick holds the lock"}
    try:
        return _tick_locked(cfg)
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


def _tick_locked(cfg: dict) -> dict:
    ledger = load_ledger(cfg)
    refresh_targets(cfg)
    deadline = time.monotonic() + TICK_DEADLINE_S

    # Claim anything pending. A claimed run leaves the pending list; we keep its
    # bundle in the ledger and work it across ticks. Save right after each claim
    # so a crash mid-tick never loses a claimed run (it can't be re-claimed).
    pending = canvas(cfg, "GET", "/api/conductor/pending").get("runs", [])
    summary = {"claimed": 0, "created": 0, "delivered": 0, "runs": {}}
    for item in pending:
        if time.monotonic() > deadline:
            break
        run_id = item.get("runId")
        if not isinstance(run_id, str) or run_id in ledger["runs"]:
            continue
        ok, why = validate_bundle(item.get("bundle"), run_id)
        if not ok:
            # Refuse the bundle; do not claim. Report nothing (not ours yet).
            summary["runs"][run_id] = f"refused_bundle:{why}"
            continue
        if canvas(cfg, "POST", f"/api/conductor/claim/{run_id}").get("claimed"):
            ledger["runs"][run_id] = {"bundle": item["bundle"], "tasks": {}, "deliveries": {}, "done": False}
            summary["claimed"] += 1
            save_ledger(cfg, ledger)

    for run_id, state in list(ledger["runs"].items()):
        if state["done"] or time.monotonic() > deadline:
            continue
        try:
            summary["runs"][run_id] = advance_run(cfg, ledger, run_id, state, summary)
        except ConductorError as err:
            # One bad run must not stop the others. Leave it for the next tick.
            summary["runs"][run_id] = f"error:{err}"
        except (KeyError, TypeError, ValueError) as err:
            summary["runs"][run_id] = f"bad_state:{err}"
        save_ledger(cfg, ledger)

    save_ledger(cfg, ledger)
    return summary


def validate_bundle(bundle, run_id: str) -> tuple:
    """Refuse anything that is not a well-formed run bundle for this run."""
    if not isinstance(bundle, dict):
        return False, "not an object"
    if bundle.get("kind") != "workflow-canvas.run-bundle" or bundle.get("version") != 1:
        return False, "wrong kind/version"
    if bundle.get("runId") != run_id or bundle.get("keyPrefix") != f"wc:{run_id}:":
        return False, "run id mismatch"
    steps = bundle.get("steps")
    if not isinstance(steps, list):
        return False, "steps not a list"
    keys = set()
    for step in steps:
        if not isinstance(step, dict):
            return False, "step not an object"
        key = step.get("key")
        if not isinstance(key, str) or not key.startswith(bundle["keyPrefix"]) or key in keys:
            return False, "bad or duplicate step key"
        keys.add(key)
        if step.get("role") not in ("run", "approval"):
            return False, "bad role"
        if not isinstance(step.get("title"), str) or not isinstance(step.get("body"), str):
            return False, "bad title/body"
        mins = step.get("maxRuntimeMinutes")
        if not isinstance(mins, int) or not (1 <= mins <= 1440):
            return False, "bad runtime"
        for pk in step.get("waitsForKeys", []):
            if pk not in keys and pk not in {s.get("key") for s in steps}:
                return False, "waitsFor unknown key"
    return True, ""


def advance_run(cfg: dict, ledger: dict, run_id: str, state: dict, summary: dict) -> str:
    bundle = state["bundle"]
    steps = bundle["steps"]
    by_key = {step["key"]: step for step in steps}
    decides_of = {s["cardId"]: s.get("decides", []) for s in steps if s.get("decides")}

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

    # Read the outcome of every task WE created. Only our own ids; a task we did
    # not create can never satisfy a gate here.
    outcomes: dict = {}   # card id -> outcome
    branch_of: dict = {}  # decision card id -> reported branch (only when the task is done)
    for key, task_id in state["tasks"].items():
        card_id = by_key[key]["cardId"]
        task = hermes_json(cfg, kanban(cfg, "show", task_id, "--json"))
        task = task.get("task", task)
        status = KANBAN_TO_OUTCOME.get(task.get("status", ""), "running")
        outcomes[card_id] = status
        if status == "completed":
            meta = task.get("metadata") or {}
            if isinstance(meta, dict) and isinstance(meta.get("branch"), str):
                branch_of[card_id] = meta["branch"]

    # A decision step that finished must report exactly one of its listed branch
    # values. Anything else stops the run (RUN-PLAN 12.1: "branch not reported").
    for card_id, allowed in decides_of.items():
        if outcomes.get(card_id) == "completed":
            chosen = branch_of.get(card_id)
            if chosen is None or chosen not in allowed:
                report(cfg, run_id, steps, outcomes, state["deliveries"], "blocked")
                state["done"] = True
                return "blocked:branch-not-reported"

    dead = compute_dead(steps, by_key, outcomes, branch_of, approvals, decides_of)

    # A failed or blocked step stops the run: create nothing more.
    if any(outcomes.get(by_key[k]["cardId"]) in ("failed", "blocked") for k in state["tasks"]):
        deliver(cfg, run_id, bundle, state, outcomes, dead, ledger, summary)
        report(cfg, run_id, steps, outcomes, state["deliveries"], "failed")
        state["done"] = True
        return "failed"

    # Create due steps.
    for step in steps:
        key = step["key"]
        if key in state["tasks"] or step["role"] == "approval" or step["cardId"] in dead:
            continue
        if step_readiness(step, by_key, outcomes, branch_of, approvals, dead, decides_of) != "due":
            continue
        task_id = create_step(cfg, run_id, step, state, ledger)
        state["tasks"][key] = task_id
        outcomes[step["cardId"]] = "created"
        summary["created"] += 1

    deliver(cfg, run_id, bundle, state, outcomes, dead, ledger, summary)

    run_status = roll_up(bundle, state, outcomes, dead, approvals)
    report(cfg, run_id, steps, outcomes, state["deliveries"], run_status)
    if run_status in ("completed", "stopped"):
        state["done"] = True
    return run_status


def compute_dead(steps, by_key, outcomes, branch_of, approvals, decides_of) -> set:
    """Cards that will never be created: an untaken branch, or every parent dead."""
    dead: set = set()
    changed = True
    while changed:
        changed = False
        for step in steps:
            cid = step["cardId"]
            if cid in dead:
                continue
            d = False
            for req in step.get("branches", []):
                dcard = req["decisionCardId"]
                if outcomes.get(dcard) == "completed":
                    chosen = branch_of.get(dcard)
                    if chosen in (decides_of.get(dcard) or []) and chosen not in req["branches"]:
                        d = True
            parents = step.get("waitsForKeys", [])
            if parents:
                all_dead = True
                for pk in parents:
                    parent = by_key.get(pk)
                    if parent is None:
                        all_dead = False
                        continue
                    pcid = parent["cardId"]
                    pdead = pcid in dead or (parent["role"] == "approval" and approvals.get(pcid) == "rejected")
                    if not pdead:
                        all_dead = False
                if all_dead:
                    d = True
            if d:
                dead.add(cid)
                changed = True
    return dead


def step_readiness(step, by_key, outcomes, branch_of, approvals, dead, decides_of) -> str:
    """'due' or 'wait' for a not-created, not-dead run step. A dead parent is ignored (join)."""
    for parent_key in step.get("waitsForKeys", []):
        parent = by_key.get(parent_key)
        if parent is None:
            return "wait"
        card_id = parent["cardId"]
        if card_id in dead or (parent["role"] == "approval" and approvals.get(card_id) == "rejected"):
            continue  # a dead/rejected parent is not waited on; a live path carries this join
        if parent["role"] == "approval":
            if approvals.get(card_id) != "approved":
                return "wait"
        elif outcomes.get(card_id) != "completed":
            return "wait"
    for requirement in step.get("branches", []):
        decision_card = requirement["decisionCardId"]
        if outcomes.get(decision_card) != "completed":
            return "wait"
        chosen = branch_of.get(decision_card)
        if chosen not in requirement["branches"]:
            return "wait"
    return "due"


def safe_title(title: str) -> str:
    """A Kanban title that can never be read as a CLI option or carry control chars."""
    cleaned = "".join(ch for ch in title if ch >= " " and ch != "\x7f").strip()
    return cleaned or "Workflow Canvas step"


def create_step(cfg: dict, run_id: str, step: dict, state: dict, ledger: dict) -> str:
    parents = [
        state["tasks"][parent_key]
        for parent_key in step.get("waitsForKeys", [])
        if parent_key in state["tasks"]
    ]
    # The idempotency key is unguessable, so no one can pre-create a task under a
    # later step's key and have the conductor adopt it (Rule 3).
    idem = "wck:" + hmac.new(cfg["secret"].encode(), step["key"].encode(), hashlib.sha256).hexdigest()[:24]
    args = kanban(
        cfg, "create",
        "--assignee", step["assignee"],
        "--idempotency-key", idem,
        "--max-retries", "1",
        "--max-runtime", f"{int(step['maxRuntimeMinutes'])}m",
        "--workspace", "scratch",
        "--json",
    )
    for skill in step.get("skills", []):
        args += ["--skill", skill]
    for parent in parents:
        args += ["--parent", parent]
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as handle:
        handle.write(step["body"])
        body_path = handle.name
    try:
        # `--` ends options so a title starting with '-' can never be read as a flag.
        args += ["--body-file", body_path, "--", safe_title(step["title"])]
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
    # Adopt a task only if it is not already one of ours. A replayed id we already
    # hold would mean tampering; stop rather than trust it.
    for other_id, other in ledger["runs"].items():
        for existing_key, existing_id in other["tasks"].items():
            if existing_id == task_id and not (other_id == run_id and existing_key == step["key"]):
                raise ConductorError(f"create returned an id already in the ledger ({task_id}); refusing (possible tampering)")
    return task_id


def deliver(cfg: dict, run_id: str, bundle: dict, state: dict, outcomes: dict, dead: set, ledger: dict, summary: dict) -> None:
    by_key = {step["key"]: step for step in bundle["steps"]}
    for delivery in bundle.get("deliveries", []):
        card_id = delivery["cardId"]
        if state["deliveries"].get(card_id):
            continue  # already attempted, sent, failed or skipped: at most once
        after = [by_key[key] for key in delivery.get("afterKeys", []) if key in by_key]
        if not after:
            continue
        # If any producing step is on a dead path, the output is never made.
        if any(step["cardId"] in dead for step in after):
            state["deliveries"][card_id] = "skipped"
            continue
        run_producers = [step for step in after if step["role"] == "run"]
        if not run_producers or not all(outcomes.get(step["cardId"]) == "completed" for step in run_producers):
            continue  # still waiting on a producer
        # Mark the attempt before acting, so a crash never causes a second send.
        state["deliveries"][card_id] = "attempting"
        save_ledger(cfg, ledger)
        ok = perform_delivery(cfg, run_id, delivery)
        state["deliveries"][card_id] = "sent" if ok else "failed"
        save_ledger(cfg, ledger)
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


def roll_up(bundle: dict, state: dict, outcomes: dict, dead: set, approvals: dict) -> str:
    steps = bundle["steps"]
    # A run step is still pending if it's alive but not yet created-and-completed.
    pending_run = any(
        step["role"] == "run"
        and step["cardId"] not in dead
        and (step["key"] not in state["tasks"] or outcomes.get(step["cardId"]) != "completed")
        for step in steps
    )
    # An approval is pending if it's alive and not yet decided.
    pending_approval = any(
        step["role"] == "approval"
        and step["cardId"] not in dead
        and step["cardId"] not in approvals
        for step in steps
    )
    # A delivery is pending if its producers are alive and it has not settled.
    by_key = {step["key"]: step for step in steps}
    def settled(card_id: str) -> bool:
        return state["deliveries"].get(card_id) in ("sent", "failed", "skipped")
    pending_delivery = any(
        not settled(d["cardId"])
        and not any(by_key[k]["cardId"] in dead for k in d.get("afterKeys", []) if k in by_key)
        for d in bundle.get("deliveries", [])
    )
    if pending_run or pending_approval or pending_delivery:
        return "waiting-approval" if (pending_approval and not pending_run) else "running"
    # Nothing left to do. A rejected approval means the run was stopped on purpose.
    if any(decision == "rejected" for decision in approvals.values()):
        return "stopped"
    return "completed"


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


# --- installer ---------------------------------------------------------------

RUNNER_PROFILE_CONFIG = """# Workflow Canvas runner profile — minimal and isolated.
# Written by the Workflow Canvas conductor installer. Review before a real run
# (R4): confirm the toolset and that workers cannot read other profiles' .env.
terminal:
  # Credential isolation (R2.0 finding 9): run workers in a container so a step
  # cannot read ~/.hermes/.env or another profile's bot token.
  backend: docker
"""


def hermes_cli(hermes_bin: str, args: list) -> tuple:
    proc = subprocess.run([hermes_bin, *args], capture_output=True, text=True, timeout=120)
    return proc.returncode, proc.stdout, proc.stderr


def pair_with_canvas(canvas_url: str, code: str) -> str | None:
    body = json.dumps({"code": code}).encode("utf-8")
    req = urllib.request.Request(canvas_url.rstrip("/") + "/api/conductor/pair", data=body, method="POST")
    req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8")).get("token")
    except urllib.error.HTTPError:
        return None
    except OSError:
        return None


def _write(path: str, text: str, mode: int | None = None) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    flags = os.O_CREAT | os.O_WRONLY | os.O_TRUNC
    fd = os.open(path, flags, mode if mode is not None else 0o644)
    try:
        os.write(fd, text.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def write_private(path: str, text: str) -> None:
    """Write a secret-bearing file created 0600 from the start (no readable window)."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    try:
        os.write(fd, text.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def do_install(args) -> int:
    hermes_home = args.hermes_home or os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    config_path = os.path.abspath(args.config)
    config_dir = os.path.dirname(config_path)
    scripts_dir = os.path.join(hermes_home, "scripts")
    wrapper = os.path.join(scripts_dir, "workflow-canvas-conductor.sh")
    profile_dir = os.path.join(hermes_home, "profiles", args.profile)
    canvas_url = args.canvas.rstrip("/")
    conductor_path = os.path.abspath(__file__)

    plan = [
        f"Pair with Canvas at {canvas_url}; store a conductor token in {config_path} (mode 600).",
        f"Create a minimal runner profile '{args.profile}' (hermes profile create --no-skills).",
        f"Write {os.path.join(profile_dir, 'config.yaml')} with terminal.backend=docker (credential isolation).",
        f"Create the dedicated Kanban board '{args.board}' (hermes kanban boards create).",
        f"Write the tick wrapper {wrapper}.",
        "Add a cron job 'every 1m', --no-agent --deliver local, running the wrapper.",
        f"Write the conductor config {config_path} (mode 600): board, allowlist=[{args.profile}], no skills.",
    ]
    print("The installer will make these changes:")
    for i, line in enumerate(plan, 1):
        print(f"  {i}. {line}")
    if args.dry_run:
        print("\n--dry-run: no changes made.")
        return 0

    def confirm(step: str) -> bool:
        if args.yes:
            return True
        try:
            return input(f"Proceed: {step}? [y/N] ").strip().lower() in ("y", "yes")
        except EOFError:
            return False

    if not confirm("pair with Canvas"):
        print("Aborted before any change.")
        return 1
    token = pair_with_canvas(canvas_url, args.pair)
    if not token:
        print("conductor: pairing failed (code bad, expired, or already used). No changes made.", file=sys.stderr)
        return 1

    if confirm(f"create runner profile '{args.profile}'"):
        code, _, err = hermes_cli(args.hermes_bin, ["profile", "create", args.profile, "--no-skills", "--description", "Workflow Canvas runner: minimal, isolated; runs only approved steps."])
        if code != 0:
            print(f"conductor: profile create failed: {err.strip()}", file=sys.stderr)

    if confirm("write the runner profile config"):
        _write(os.path.join(profile_dir, "config.yaml"), RUNNER_PROFILE_CONFIG)

    if confirm(f"create board '{args.board}'"):
        hermes_cli(args.hermes_bin, ["kanban", "boards", "create", args.board, "--name", "Workflow Canvas"])

    if confirm("write the tick wrapper"):
        _write(wrapper, f"#!/usr/bin/env bash\n# Workflow Canvas conductor tick. Runs model-free, delivers nothing itself.\nexec python3 -I {conductor_path} --config {config_path} tick\n", 0o755)

    cron_job_id = None
    if confirm("add the every-1m cron job"):
        code, out, err = hermes_cli(args.hermes_bin, ["cron", "create", "every 1m", "--name", "workflow-canvas-conductor", "--no-agent", "--deliver", "local", "--script", wrapper])
        if code == 0:
            try:
                cron_job_id = json.loads(out).get("id")
            except (json.JSONDecodeError, AttributeError):
                cron_job_id = None
        else:
            print(f"conductor: cron create failed: {err.strip()}", file=sys.stderr)

    cfg = {
        "canvas_url": canvas_url, "token": token, "board": args.board,
        "ledger_path": os.path.join(config_dir, "ledger.json"),
        "allowed_profiles": [args.profile], "allowed_skills": [],
        "hermes_bin": args.hermes_bin, "delivery_dir": os.path.join(config_dir, "deliveries"),
        "targets": {}, "cron_job_id": cron_job_id,
    }
    if confirm("write the conductor config"):
        _write(config_path, json.dumps(cfg, indent=2), 0o600)
    print("Install complete. The conductor will start work on the next cron tick.")
    return 0


def do_uninstall(args) -> int:
    config_path = os.path.abspath(args.config)
    try:
        cfg = load_config(config_path)
    except (OSError, ConductorError, json.JSONDecodeError) as err:
        print(f"conductor: cannot load config to uninstall: {err}", file=sys.stderr)
        return 2
    hermes_home = args.hermes_home or os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    wrapper = os.path.join(hermes_home, "scripts", "workflow-canvas-conductor.sh")
    if cfg.get("cron_job_id"):
        hermes_cli(cfg["hermes_bin"], ["cron", "remove", cfg["cron_job_id"]])
    # Best-effort: tell Canvas to forget this connection's token.
    try:
        req = urllib.request.Request(cfg["canvas_url"] + "/api/connection", method="DELETE")
        urllib.request.urlopen(req, timeout=15).close()
    except OSError:
        pass
    for path in (wrapper, config_path):
        try:
            os.unlink(path)
        except OSError:
            pass
    print("Uninstalled: removed the cron job, the tick wrapper, and the config (token). The board and its history are kept.")
    return 0


def do_allow(args, kind: str) -> int:
    config_path = os.path.abspath(args.config)
    cfg = load_config(config_path)
    key = "allowed_profiles" if kind == "profile" else "allowed_skills"
    if args.name not in cfg[key]:
        cfg[key].append(args.name)
        _write(config_path, json.dumps(cfg, indent=2), 0o600)
        print(f"Allowed {kind}: {args.name}")
    else:
        print(f"{kind} already allowed: {args.name}")
    return 0


# --- CLI ---------------------------------------------------------------------


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description="Workflow Canvas conductor (Hermes side).")
    parser.add_argument("--config", default=os.environ.get(CONFIG_ENV, DEFAULT_CONFIG))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("tick", help="Run one pass: claim, create due steps, deliver, report.")
    sub.add_parser("status", help="Print the ledger summary.")

    inst = sub.add_parser("install", help="Create the runner profile, board, config and cron job.")
    inst.add_argument("--canvas", required=True, help="Canvas base URL, e.g. http://127.0.0.1:8787")
    inst.add_argument("--pair", required=True, help="The one-time pairing code shown in Canvas.")
    inst.add_argument("--board", default="workflow-canvas")
    inst.add_argument("--profile", default="canvas-runner")
    inst.add_argument("--hermes-home", default=None)
    inst.add_argument("--hermes-bin", default="hermes")
    inst.add_argument("--tunnel", default=None, help="Optional SSH tunnel user@host (recorded for the operator; not opened here).")
    inst.add_argument("--dry-run", action="store_true")
    inst.add_argument("--yes", action="store_true", help="Skip per-step confirmation.")

    un = sub.add_parser("uninstall", help="Remove the cron job, wrapper and config; keep the board.")
    un.add_argument("--hermes-home", default=None)

    ap = sub.add_parser("allow-profile", help="Add a profile to the allowlist.")
    ap.add_argument("name")
    ask = sub.add_parser("allow-skill", help="Add a skill to the allowlist.")
    ask.add_argument("name")

    args = parser.parse_args(argv)

    try:
        if args.command == "install":
            return do_install(args)
        if args.command == "uninstall":
            return do_uninstall(args)
        if args.command == "allow-profile":
            return do_allow(args, "profile")
        if args.command == "allow-skill":
            return do_allow(args, "skill")

        cfg = load_config(args.config)
        if args.command == "tick":
            print(json.dumps(tick(cfg)))
            return 0
        if args.command == "status":
            ledger = load_ledger(cfg)
            runs = {rid: {"done": s["done"], "tasks": len(s["tasks"]), "deliveries": s["deliveries"]} for rid, s in ledger["runs"].items()}
            redacted = {k: ("<set>" if k == "token" else v) for k, v in cfg.items()}
            print(json.dumps({"config": redacted, "runs": runs}))
            return 0
    except (OSError, ConductorError, json.JSONDecodeError) as err:
        print(f"conductor: {err}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
