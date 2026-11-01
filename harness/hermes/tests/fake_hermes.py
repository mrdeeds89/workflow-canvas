#!/usr/bin/env python3
"""A fake `hermes` CLI for conductor tests.

It implements just enough of `hermes kanban` and `hermes send` to drive the
conductor, backed by a JSON board file named in FAKE_HERMES_BOARD. Tests edit
that file between ticks to simulate workers finishing tasks and reporting
branches. It records every `send` invocation in FAKE_HERMES_SENDLOG.

This is test scaffolding, not Hermes.
"""

import json
import os
import sys


def board_path() -> str:
    return os.environ["FAKE_HERMES_BOARD"]


def load_board() -> dict:
    try:
        with open(board_path(), "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return {"seq": 0, "tasks": {}}


def save_board(board: dict) -> None:
    with open(board_path(), "w", encoding="utf-8") as handle:
        json.dump(board, handle)


def take(args: list, flag: str):
    if flag in args:
        return args[args.index(flag) + 1]
    return None


def take_all(args: list, flag: str) -> list:
    out = []
    i = 0
    while i < len(args):
        if args[i] == flag and i + 1 < len(args):
            out.append(args[i + 1])
            i += 2
        else:
            i += 1
    return out


VALUE_FLAGS = {
    "--board", "--assignee", "--idempotency-key", "--max-retries",
    "--max-runtime", "--workspace", "--skill", "--parent", "--body-file",
    "-t", "-s", "-f",
}


def first_positional(args: list) -> str:
    skip = False
    for tok in args:
        if skip:
            skip = False
            continue
        if tok in VALUE_FLAGS:
            skip = True
            continue
        if tok.startswith("-"):
            continue
        return tok
    return ""


def kanban(args: list) -> int:
    verb = None
    for tok in args:
        if tok in ("create", "show", "list", "archive", "complete", "init"):
            verb = tok
            break
    board = load_board()
    if verb == "create":
        title = first_positional([a for a in args if a != "create"])
        key = take(args, "--idempotency-key")
        if key:
            for task in board["tasks"].values():
                if task.get("idempotency_key") == key:
                    print(json.dumps(task))
                    return 0
        board["seq"] += 1
        task_id = f"t_fake_{board['seq']}"
        task = {
            "id": task_id,
            "title": title,
            "status": "ready",
            "assignee": take(args, "--assignee"),
            "skills": take_all(args, "--skill"),
            "parents": take_all(args, "--parent"),
            "idempotency_key": key,
            "metadata": {},
            "result": None,
        }
        board["tasks"][task_id] = task
        save_board(board)
        print(json.dumps(task))
        return 0
    if verb == "show":
        task_id = first_positional([a for a in args if a != "show"])
        task = board["tasks"].get(task_id)
        if not task:
            print(f"no such task {task_id}", file=sys.stderr)
            return 1
        print(json.dumps({"task": task}))
        return 0
    if verb == "list":
        print(json.dumps(list(board["tasks"].values())))
        return 0
    if verb == "archive":
        task_id = first_positional([a for a in args if a != "archive"])
        if task_id in board["tasks"]:
            board["tasks"][task_id]["status"] = "archived"
            save_board(board)
        print(json.dumps({"ok": True}))
        return 0
    if verb == "init":
        save_board(board)
        print(json.dumps({"ok": True}))
        return 0
    print(f"fake_hermes: unknown kanban verb in {args}", file=sys.stderr)
    return 2


def send(args: list) -> int:
    log = os.environ.get("FAKE_HERMES_SENDLOG")
    if "--list" in args:
        print(json.dumps({"targets": [{"target": "telegram", "label": "Telegram"}]}))
        return 0
    target = take(args, "-t") or ""
    path = take(args, "-f")
    if log:
        with open(log, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"target": target, "file": path}) + "\n")
    if "fail" in target:
        print(json.dumps({"error": f"Platform '{target}' is not configured."}))
        return 0
    print(json.dumps({"ok": True, "target": target}))
    return 0


def log_cmd(argv: list) -> None:
    path = os.environ.get("FAKE_HERMES_CMDLOG")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(argv) + "\n")


def profile(args: list) -> int:
    # create <name> ... | delete <name> | list
    if args and args[0] == "create":
        print(json.dumps({"ok": True, "profile": first_positional(args[1:])}))
        return 0
    if args and args[0] in ("delete", "list"):
        print(json.dumps({"ok": True}))
        return 0
    return 0


def boards(args: list) -> int:
    # create <slug> --name N | rm <slug> --delete | list
    if args and args[0] in ("create", "new"):
        print(json.dumps({"ok": True, "slug": first_positional(args[1:])}))
        return 0
    print(json.dumps({"ok": True}))
    return 0


def cron(args: list) -> int:
    if args and args[0] in ("create", "add"):
        print(json.dumps({"ok": True, "id": "cron_fake_1"}))
        return 0
    if args and args[0] in ("remove", "rm", "delete", "list"):
        print(json.dumps({"ok": True}))
        return 0
    return 0


def main(argv: list) -> int:
    if not argv:
        return 2
    log_cmd(argv)
    group, rest = argv[0], argv[1:]
    if group == "kanban":
        # boards is a kanban subgroup: `kanban --board X boards ...` or `kanban boards ...`
        if "boards" in rest:
            return boards(rest[rest.index("boards") + 1:])
        return kanban(rest)
    if group == "send":
        return send(rest)
    if group == "profile":
        return profile(rest)
    if group == "cron":
        return cron(rest)
    print(f"fake_hermes: unknown group {group}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
