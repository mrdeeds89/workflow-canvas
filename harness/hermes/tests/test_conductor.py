#!/usr/bin/env python3
"""Conductor tests against a stub Canvas and a fake hermes.

Hermetic: no node, no docker, no real Hermes. A small HTTP stub stands in for
Canvas's conductor routes (the real routes are proven in TypeScript), and
fake_hermes.py stands in for the CLI. The test drives the conductor one tick
at a time, editing the fake board between ticks to simulate workers.

Run with:  python3 -I -m unittest harness/hermes/tests/test_conductor.py
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CONDUCTOR = os.path.join(os.path.dirname(HERE), "workflow_canvas_conductor.py")
FAKE_HERMES = os.path.join(HERE, "fake_hermes.py")
TOKEN = "test-token-" + "0" * 40


class StubState:
    def __init__(self):
        self.pending = {}      # runId -> bundle
        self.claimed = set()
        self.runs = {}         # runId -> {status, cancelled, stopped, approvals:[{cardId,decision}]}
        self.reports = {}      # runId -> last payload
        self.targets = None

    def add_run(self, run_id, bundle):
        self.pending[run_id] = bundle
        self.runs[run_id] = {"status": "requested", "cancelled": False, "stopped": False, "approvals": []}


def make_handler(state: StubState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _auth_ok(self):
            return self.headers.get("authorization") == "Bearer " + TOKEN

        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            length = int(self.headers.get("content-length", 0))
            return json.loads(self.rfile.read(length) or b"{}")

        def do_GET(self):
            if not self._auth_ok():
                return self._send(401, {"error": "unauthorized"})
            if self.path == "/api/conductor/pending":
                runs = [{"runId": rid, "workflowId": "w", "revision": 1, "bundle": b} for rid, b in state.pending.items() if rid not in state.claimed]
                return self._send(200, {"runs": runs})
            if self.path.startswith("/api/conductor/run/"):
                rid = self.path.rsplit("/", 1)[1]
                run = state.runs.get(rid)
                if not run:
                    return self._send(404, {"error": "no"})
                return self._send(200, {"runId": rid, **run})
            return self._send(404, {"error": "no"})

        def do_POST(self):
            if not self._auth_ok():
                return self._send(401, {"error": "unauthorized"})
            if self.path.startswith("/api/conductor/claim/"):
                rid = self.path.rsplit("/", 1)[1]
                if rid in state.pending and rid not in state.claimed:
                    state.claimed.add(rid)
                    return self._send(200, {"claimed": True})
                return self._send(409, {"claimed": False})
            if self.path.startswith("/api/conductor/report/"):
                rid = self.path.rsplit("/", 1)[1]
                state.reports[rid] = self._body()
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "no"})

        def do_PUT(self):
            if not self._auth_ok():
                return self._send(401, {"error": "unauthorized"})
            if self.path == "/api/conductor/targets":
                state.targets = self._body().get("targets")
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "no"})

    return Handler


def step(key, card, role="run", assignee="runner", waits=None, branches=None, decides=None, skills=None):
    return {
        "key": key, "cardId": card, "title": card, "role": role, "stage": 0,
        "assignee": assignee if role == "run" else "", "skills": skills or [],
        "maxRuntimeMinutes": 30, "waitsForKeys": waits or [],
        "branches": branches or [], "decides": decides or [],
        "body": f"Do {card}.",
    }


def bundle(run_id, steps, deliveries=None):
    return {
        "kind": "workflow-canvas.run-bundle", "version": 1, "runId": run_id,
        "workflowId": "w", "workflowTitle": "W", "revision": 1, "digest": "d",
        "keyPrefix": f"wc:{run_id}:", "stageCount": 1,
        "steps": steps, "deliveries": deliveries or [],
    }


class ConductorTest(unittest.TestCase):
    def setUp(self):
        os.chmod(FAKE_HERMES, 0o755)
        self.state = StubState()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.state))
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.dir = tempfile.mkdtemp(prefix="wc-conductor-")
        self.board = os.path.join(self.dir, "board.json")
        self.sendlog = os.path.join(self.dir, "sendlog.jsonl")
        self.ledger = os.path.join(self.dir, "ledger.json")
        cfg = {
            "canvas_url": f"http://127.0.0.1:{self.port}",
            "token": TOKEN, "board": "test-board", "ledger_path": self.ledger,
            "allowed_profiles": ["runner"], "allowed_skills": ["daily-digest"],
            "hermes_bin": FAKE_HERMES, "delivery_dir": os.path.join(self.dir, "deliveries"),
            "targets": {"t:telegram": "telegram"},
        }
        self.cfg_path = os.path.join(self.dir, "cfg.json")
        with open(self.cfg_path, "w") as h:
            json.dump(cfg, h)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def tick(self):
        env = dict(os.environ, FAKE_HERMES_BOARD=self.board, FAKE_HERMES_SENDLOG=self.sendlog)
        proc = subprocess.run(
            [sys.executable, "-I", CONDUCTOR, "--config", self.cfg_path, "tick"],
            capture_output=True, text=True, env=env,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout or "{}")

    def read_board(self):
        try:
            with open(self.board) as h:
                return json.load(h)
        except FileNotFoundError:
            return {"tasks": {}}

    def set_task(self, title_contains, **fields):
        board = self.read_board()
        for task in board["tasks"].values():
            if title_contains in task["title"]:
                task.update(fields)
        with open(self.board, "w") as h:
            json.dump(board, h)

    def tasks(self):
        return list(self.read_board()["tasks"].values())

    # --- tests ---

    def test_due_steps_created_exactly_once(self):
        self.state.add_run("r1", bundle("r1", [
            step("wc:r1:a", "a"),
            step("wc:r1:b", "b", waits=["wc:r1:a"]),
        ]))
        self.tick()  # claims r1, creates a; b waits
        titles = sorted(t["title"] for t in self.tasks())
        self.assertEqual(titles, ["a"])
        self.set_task("a", status="done")
        self.tick()  # creates b
        self.tick()  # no duplicates
        titles = sorted(t["title"] for t in self.tasks())
        self.assertEqual(titles, ["a", "b"])
        self.assertEqual(len(self.tasks()), 2)

    def test_approval_gates_the_next_stage(self):
        self.state.add_run("r2", bundle("r2", [
            step("wc:r2:draft", "draft"),
            step("wc:r2:ok", "ok", role="approval", waits=["wc:r2:draft"]),
            step("wc:r2:send", "send", waits=["wc:r2:ok"]),
        ]))
        self.tick()
        self.set_task("draft", status="done")
        self.tick()  # ok is an approval, not approved yet -> send must not appear
        self.assertNotIn("send", [t["title"] for t in self.tasks()])
        self.state.runs["r2"]["approvals"] = [{"cardId": "ok", "decision": "approved"}]
        self.tick()
        self.assertIn("send", [t["title"] for t in self.tasks()])

    def test_rejected_approval_never_creates_downstream(self):
        self.state.add_run("r3", bundle("r3", [
            step("wc:r3:draft", "draft"),
            step("wc:r3:ok", "ok", role="approval", waits=["wc:r3:draft"]),
            step("wc:r3:send", "send", waits=["wc:r3:ok"]),
        ]))
        self.tick()
        self.set_task("draft", status="done")
        self.state.runs["r3"]["approvals"] = [{"cardId": "ok", "decision": "rejected"}]
        self.tick()
        self.assertNotIn("send", [t["title"] for t in self.tasks()])

    def test_disallowed_profile_creates_nothing_and_reports_failed(self):
        self.state.add_run("r4", bundle("r4", [step("wc:r4:a", "a", assignee="stranger")]))
        self.tick()
        self.assertEqual(self.tasks(), [])
        self.assertEqual(self.state.reports["r4"]["runStatus"], "failed")

    def test_disallowed_skill_creates_nothing(self):
        self.state.add_run("r5", bundle("r5", [step("wc:r5:a", "a", skills=["forbidden"])]))
        self.tick()
        self.assertEqual(self.tasks(), [])
        self.assertEqual(self.state.reports["r5"]["runStatus"], "failed")

    def test_branch_taken_and_untaken(self):
        self.state.add_run("r6", bundle("r6", [
            step("wc:r6:d", "d", decides=["pass", "fail"]),
            step("wc:r6:p", "p", waits=["wc:r6:d"], branches=[{"decisionCardId": "d", "branches": ["pass"]}]),
            step("wc:r6:f", "f", waits=["wc:r6:d"], branches=[{"decisionCardId": "d", "branches": ["fail"]}]),
        ]))
        self.tick()  # creates d
        self.set_task("d", status="done", metadata={"branch": "pass"})
        self.tick()
        titles = sorted(t["title"] for t in self.tasks())
        self.assertEqual(titles, ["d", "p"], "the pass branch is created, the fail branch is not")

    def test_local_file_delivery_happens_once(self):
        self.state.add_run("r7", bundle(
            "r7",
            [step("wc:r7:make", "make")],
            deliveries=[{"cardId": "out", "targetId": "local-file", "afterKeys": ["wc:r7:make"], "localFile": True}],
        ))
        self.tick()
        self.set_task("make", status="done")
        self.tick()
        delivered = os.path.join(self.dir, "deliveries", "r7-out.txt")
        self.assertTrue(os.path.exists(delivered))
        self.assertEqual(self.state.reports["r7"]["deliveries"], [{"cardId": "out", "status": "sent"}])
        # No send for a local file.
        self.assertFalse(os.path.exists(self.sendlog))
        self.tick()  # not re-delivered
        self.assertEqual(self.state.reports["r7"]["deliveries"], [{"cardId": "out", "status": "sent"}])

    def test_messaging_delivery_sends_once(self):
        self.state.add_run("r8", bundle(
            "r8",
            [step("wc:r8:make", "make")],
            deliveries=[{"cardId": "out", "targetId": "t:telegram", "afterKeys": ["wc:r8:make"], "localFile": False}],
        ))
        self.tick()
        self.set_task("make", status="done")
        self.tick()
        self.tick()  # must not send twice
        with open(self.sendlog) as h:
            lines = [l for l in h.read().splitlines() if l.strip()]
        self.assertEqual(len(lines), 1, "exactly one send")
        self.assertEqual(json.loads(lines[0])["target"], "telegram")

    def test_cancel_archives_and_creates_nothing(self):
        self.state.add_run("r9", bundle("r9", [
            step("wc:r9:a", "a"),
            step("wc:r9:b", "b", waits=["wc:r9:a"]),
        ]))
        self.tick()  # creates a
        self.state.runs["r9"]["cancelled"] = True
        self.state.runs["r9"]["status"] = "cancelled"
        self.tick()
        statuses = [t["status"] for t in self.tasks()]
        self.assertEqual(statuses, ["archived"])
        self.assertEqual(len(self.tasks()), 1, "b was never created after cancel")


if __name__ == "__main__":
    unittest.main()
