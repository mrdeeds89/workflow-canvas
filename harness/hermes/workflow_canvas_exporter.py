#!/usr/bin/env python3
"""Read-only snapshot of one Hermes cron job for Workflow Canvas.

Prints one JSON observation on stdout and nothing else. It never writes under
the Hermes home, never imports Hermes, never starts, pauses, resumes, edits or
deletes a job, and never prints prompt text, delivery targets, paths, model or
provider settings, error text, or run output.

Intended to be the forced command of a restricted SSH key, one key per Hermes
profile:

    restrict,command="/usr/bin/python3 -I /opt/wc-exporter/workflow_canvas_exporter.py --profile <p>" ssh-ed25519 ...

The caller may then ask for exactly one thing: ``snapshot <job_id>``. The
profile comes from the key, never from the caller.

Standard library only. Run with ``python3 -I``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import sqlite3
import sys
import tempfile
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

FORMAT = "workflow-canvas.hermes-observation"
FORMAT_VERSION = 1
EXPORTER_VERSION = "0.1.0"

# Hermes releases whose cron store layout this exporter was checked against.
# A release outside this list is reported as unsupported rather than guessed.
SUPPORTED_HERMES_SERIES = ("0.22.",)

JOB_ID_RE = re.compile(r"[0-9a-f]{6,32}")
PROFILE_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
WORD_RE = re.compile(r"[a-z][a-z0-9_]{0,39}")
PLATFORM_RE = re.compile(r"[a-z][a-z0-9_-]{0,31}")
MAX_EXECUTIONS = 10
MAX_NAME = 200
MAX_DISPLAY = 120
MAX_SKILLS = 20

# Columns the executions ledger must have. Optional ones become null if absent.
REQUIRED_EXECUTION_COLUMNS = {"id", "job_id", "source", "status", "claimed_at", "started_at", "finished_at"}
OPTIONAL_EXECUTION_COLUMNS = ("scheduled_instant", "progress_at", "delivery_outcome")

EXIT_OK = 0
EXIT_BAD_REQUEST = 2
EXIT_NOT_FOUND = 3
EXIT_UNSUPPORTED = 4
EXIT_UNREADABLE = 5


class Refusal(Exception):
    def __init__(self, code: str, exit_code: int) -> None:
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def text(value: Any, limit: int) -> Optional[str]:
    """Plain text, control characters removed, length capped. None stays None."""
    if value is None:
        return None
    cleaned = "".join(ch for ch in str(value) if ch == " " or ch.isprintable())
    return cleaned[:limit]


def word(value: Any) -> Optional[str]:
    """A status-like literal, or None. Anything else is replaced, never passed through."""
    if value is None:
        return None
    raw = str(value).strip()
    return raw if WORD_RE.fullmatch(raw) else "unrecognized"


def timestamp(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    raw = str(value).strip()[:40]
    try:
        datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return raw


# --- Hermes displayed-state rule ------------------------------------------------
# Port of cron.jobs.effective_job_state / is_job_runnable (Hermes 0.22.x).
# harness/hermes/conformance_check.py compares these against Hermes itself.

def _job_text(value: Any) -> str:
    return "" if value is None else str(value)


def has_pause_marker(job: dict) -> bool:
    return _job_text(job.get("state")).strip() == "paused" or bool(job.get("paused_at"))


def is_job_runnable(job: dict) -> bool:
    return bool(job.get("enabled", True)) and not has_pause_marker(job)


def effective_job_state(job: dict) -> str:
    stored = _job_text(job.get("state")).strip()
    if stored in {"completed", "error"}:
        return stored
    if not job.get("enabled", True):
        if has_pause_marker(job) or stored == "paused":
            return "paused"
        return stored or "paused"
    if stored == "paused" or job.get("paused_at"):
        return "scheduled"
    return stored or "scheduled"


# --- Reading ---------------------------------------------------------------------

def profile_home(root: Path, profile: str) -> Path:
    return root if profile == "default" else root / "profiles" / profile


def hermes_version(install: Path) -> Optional[str]:
    try:
        stamp = json.loads((install / "install-stamp.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    version = stamp.get("baseVersion") if isinstance(stamp, dict) else None
    return version if isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+", version) else None


def read_jobs(home: Path) -> list:
    path = home / "cron" / "jobs.json"
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        raise Refusal("store_unreadable", EXIT_UNREADABLE) from exc
    if isinstance(data, dict) and isinstance(data.get("jobs"), list):
        return [job for job in data["jobs"] if isinstance(job, dict)]
    raise Refusal("unsupported_schema", EXIT_UNSUPPORTED)


def heartbeat_age(home: Path) -> Optional[float]:
    try:
        first = (home / "cron" / "ticker_heartbeat").read_text(encoding="utf-8").split()[0]
        return max(0.0, round(time.time() - float(first), 1))
    except (OSError, ValueError, IndexError):
        return None


def _file_state(path: Path) -> tuple:
    try:
        info = path.stat()
        return (info.st_size, info.st_mtime_ns, info.st_ino)
    except FileNotFoundError:
        return ()


def read_executions(home: Path, job_id: str, root: Optional[Path] = None) -> tuple[bool, list]:
    """Read the ledger without creating, changing, or locking any file next to it.

    Hermes keeps executions.db in WAL mode and closes it between writes. Any
    ordinary SQLite open of that file, even read-only, may create -wal/-shm or
    write read-marks into -shm, and Hermes can delete the side files between
    any check and any open. So Hermes's files are never opened by SQLite
    except as ``immutable`` (no locks, no side files):

    - No -wal: every committed row is in the main file. Read it ``immutable``
      and accept the result only if the file did not change during the read.
    - A -wal: copy the main file and the -wal into a private temporary
      directory outside the Hermes home, accept the copy only if neither
      original changed while it was copied, and read the copy there.
    """
    path = home / "cron" / "executions.db"
    if not path.is_file():
        return False, []
    wal = Path(str(path) + "-wal")
    for _attempt in range(4):
        before = (_file_state(path), _file_state(wal))
        if before[1] == ():
            result = _query_executions(path, job_id, immutable=True)
        else:
            result = _query_copy(path, wal, job_id, scratch_parent(root or home))
        if result is not None and (_file_state(path), _file_state(wal)) == before:
            return result
        time.sleep(0.2)
    raise Refusal("store_unreadable", EXIT_UNREADABLE)


def scratch_parent(root: Path) -> str:
    """A temp location that is not inside the Hermes home, whatever TMPDIR says. Refuses if none."""
    hermes = root.resolve()
    for option in (tempfile.gettempdir(), "/tmp"):
        candidate = Path(option).resolve()
        if candidate != hermes and hermes not in candidate.parents:
            return str(candidate)
    raise Refusal("store_unreadable", EXIT_UNREADABLE)


def _query_copy(path: Path, wal: Path, job_id: str, parent: str) -> Optional[tuple[bool, list]]:
    """Copy db + wal into a private temp dir and read the copy. None if a source vanished."""
    with tempfile.TemporaryDirectory(prefix="wc-exporter-", dir=parent) as scratch:
        copy = Path(scratch) / "executions.db"
        try:
            shutil.copyfile(path, copy)
            shutil.copyfile(wal, Path(str(copy) + "-wal"))
        except FileNotFoundError:
            return None
        return _query_executions(copy, job_id, immutable=False)


def _query_executions(path: Path, job_id: str, *, immutable: bool) -> tuple[bool, list]:
    # Only a private copy is ever opened without ``immutable``; it may replay its WAL.
    mode = "immutable=1" if immutable else "mode=rw"
    uri = "file:" + urllib.parse.quote(str(path)) + "?" + mode
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    except sqlite3.Error as exc:
        raise Refusal("store_unreadable", EXIT_UNREADABLE) from exc
    try:
        conn.execute("PRAGMA query_only = ON")
        columns = {row[1] for row in conn.execute("PRAGMA table_info(executions)")}
        if not columns:
            return False, []
        if not REQUIRED_EXECUTION_COLUMNS.issubset(columns):
            raise Refusal("unsupported_schema", EXIT_UNSUPPORTED)
        wanted = ["id", "status", "source", "claimed_at", "started_at", "finished_at"]
        wanted += [name for name in OPTIONAL_EXECUTION_COLUMNS if name in columns]
        rows = conn.execute(
            "SELECT " + ", ".join(wanted) + " FROM executions WHERE job_id = ? "
            "ORDER BY julianday(claimed_at) DESC, claimed_at DESC, id DESC LIMIT ?",
            (job_id, MAX_EXECUTIONS),
        ).fetchall()
    except sqlite3.Error as exc:
        raise Refusal("store_unreadable", EXIT_UNREADABLE) from exc
    finally:
        conn.close()
    out = []
    for row in rows:
        record = dict(zip(wanted, row))
        out.append({
            "id": text(record.get("id"), 64),
            "status": word(record.get("status")),
            "source": word(record.get("source")),
            "scheduled_instant": timestamp(record.get("scheduled_instant")),
            "claimed_at": timestamp(record.get("claimed_at")),
            "started_at": timestamp(record.get("started_at")),
            "finished_at": timestamp(record.get("finished_at")),
            "progress_at": timestamp(record.get("progress_at")),
            "delivery_outcome": word(record.get("delivery_outcome")),
        })
    return True, out


def delivery_kinds(deliver: Any) -> list:
    """Platform names only, never the chat, channel, address or path after them."""
    targets = deliver if isinstance(deliver, list) else [deliver]
    kinds = []
    for target in targets:
        if not isinstance(target, str) or target.strip() == "":
            continue
        head = target.strip().split(":", 1)[0].lower()
        kind = head if PLATFORM_RE.fullmatch(head) else "other"
        if kind not in kinds:
            kinds.append(kind)
    return kinds[:8]


def fingerprint(job: dict) -> dict:
    """Enough to notice a changed definition, without carrying the definition."""
    definition = {key: job.get(key) for key in (
        "prompt", "skill", "skills", "script", "no_agent", "model", "provider", "base_url",
        "schedule", "timezone", "workdir", "enabled_toolsets", "deliver", "context_from",
    )}
    canonical = json.dumps(definition, sort_keys=True, separators=(",", ":"), default=str)
    skills_value = job.get("skills")
    skill_value = job.get("skill")
    raw_skills: list = []
    if isinstance(skills_value, list):
        raw_skills = skills_value
    elif isinstance(skill_value, str) and skill_value:
        raw_skills = [skill_value]
    return {
        "definition_sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        "skills": [text(name, 80) for name in raw_skills[:MAX_SKILLS] if isinstance(name, str)],
        "script_present": bool(job.get("script")),
        "no_agent": bool(job.get("no_agent")),
        "model_pinned": bool(job.get("model") or job.get("provider") or job.get("base_url")),
    }


def job_view(job: dict) -> dict:
    raw_schedule = job.get("schedule")
    schedule: dict = raw_schedule if isinstance(raw_schedule, dict) else {}
    display = schedule.get("display") or job.get("schedule_display") or schedule.get("expr")
    return {
        "job_id": text(job.get("id"), 32),
        "name": text(job.get("name"), MAX_NAME) or "",
        "schedule": {"kind": word(schedule.get("kind")), "display": text(display, MAX_DISPLAY)},
        "timezone": text(job.get("timezone"), 64) if isinstance(job.get("timezone"), str) else None,
        "display_state": word(effective_job_state(job)),
        "enabled": bool(job.get("enabled", True)),
        "runnable": is_job_runnable(job),
        "paused_at": timestamp(job.get("paused_at")),
        "next_run_at": timestamp(job.get("next_run_at")),
        "last_run_at": timestamp(job.get("last_run_at")),
        "last_status": word(job.get("last_status")),
        "has_error_detail": bool(job.get("last_error") or job.get("last_delivery_error")),
        "delivery_kinds": delivery_kinds(job.get("deliver")),
        "fingerprint": fingerprint(job),
    }


def snapshot(root: Path, install: Path, profile: str, job_id: str) -> dict:
    harness: dict = {"hermes_version": None, "exporter_version": EXPORTER_VERSION, "profile": profile}
    version = hermes_version(install)
    harness["hermes_version"] = version
    if version is None or not version.startswith(SUPPORTED_HERMES_SERIES):
        raise Refusal("unsupported_version", EXIT_UNSUPPORTED)
    home = profile_home(root, profile)
    if not (home / "cron").is_dir():
        raise Refusal("not_found", EXIT_NOT_FOUND)
    match = next((job for job in read_jobs(home) if job.get("id") == job_id), None)
    if match is None:
        raise Refusal("not_found", EXIT_NOT_FOUND)
    available, executions = read_executions(home, job_id, root)
    return {
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "observed_at": now_iso(),
        "harness": harness,
        "scheduler": {"ticker_heartbeat_age_s": heartbeat_age(home)},
        "job": job_view(match),
        "executions_available": available,
        "executions": executions,
    }


def refusal(code: str, profile: Optional[str], version: Optional[str] = None) -> dict:
    return {
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "observed_at": now_iso(),
        "harness": {"hermes_version": version, "exporter_version": EXPORTER_VERSION, "profile": profile},
        "error": {"code": code},
    }


def requested_job(argv_rest: list) -> str:
    """The one request this exporter answers: ``snapshot <job_id>``."""
    if argv_rest:
        words = argv_rest
    else:
        words = os.environ.get("SSH_ORIGINAL_COMMAND", "").split(" ")
    if len(words) == 2 and words[0] == "snapshot" and JOB_ID_RE.fullmatch(words[1]):
        return words[1]
    raise Refusal("bad_request", EXIT_BAD_REQUEST)


def _exit_on_signal(signum, _frame):
    # SystemExit unwinds through TemporaryDirectory, so a hang-up or kill
    # mid-read never leaves a copy of the ledger behind.
    raise SystemExit(128 + signum)


def main(argv: list) -> int:
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGPIPE):
        signal.signal(sig, _exit_on_signal)
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--hermes-root", default=str(Path.home() / ".hermes"))
    parser.add_argument("--hermes-install", default=None)
    try:
        args, rest = parser.parse_known_args(argv)
    except SystemExit:
        print(json.dumps(refusal("bad_request", None)))
        return EXIT_BAD_REQUEST
    profile = args.profile if PROFILE_RE.fullmatch(args.profile or "") else None
    root = Path(args.hermes_root)
    install = Path(args.hermes_install) if args.hermes_install else root / "hermes-agent"
    try:
        if profile is None:
            raise Refusal("bad_request", EXIT_BAD_REQUEST)
        job_id = requested_job(rest)
        result = snapshot(root, install, profile, job_id)
    except Refusal as exc:
        print(json.dumps(refusal(exc.code, profile, hermes_version(install))))
        return exc.exit_code
    except Exception:  # noqa: BLE001 - never leak a traceback, which can carry paths
        print(json.dumps(refusal("store_unreadable", profile)))
        return EXIT_UNREADABLE
    print(json.dumps(result, separators=(",", ":")))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
