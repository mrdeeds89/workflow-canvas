#!/usr/bin/env python3
"""Real-CLI end-to-end check for the conductor.

Skipped unless WC_REAL_HERMES=1 and a `hermes` CLI is on PATH, so it never runs
in the TypeScript (node/docker) suite. It stands up a stub Canvas, creates a
throwaway NAMED board, runs one real tick (real hermes kanban create/show/list/
archive), then deletes the board. Named boards are isolated DBs under the
kanban home; the default board is never touched.

Isolation note (verified 2026-11-01): `--board <slug>` overrides
HERMES_KANBAN_DB, and HERMES_HOME does not redirect the kanban home. The only
safe isolation is a dedicated named board — which is how the conductor is
isolated in production too.

Run:  WC_REAL_HERMES=1 python3 -I harness/hermes/tests/test_conductor_real.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CONDUCTOR = os.path.join(os.path.dirname(HERE), "workflow_canvas_conductor.py")
TOKEN = "real-token-" + "0" * 40
BOARD = "wc-selftest-ci"
RUN = "realrun1"

BUNDLE = {
    "kind": "workflow-canvas.run-bundle", "version": 1, "runId": RUN,
    "workflowId": "w", "workflowTitle": "W", "revision": 1, "digest": "d",
    "keyPrefix": f"wc:{RUN}:", "stageCount": 1,
    "steps": [{
        "key": f"wc:{RUN}:a", "cardId": "a", "title": "wc selftest step a", "role": "run",
        "stage": 0, "assignee": "canvas-runner", "skills": [], "maxRuntimeMinutes": 5,
        "waitsForKeys": [], "branches": [], "decides": [], "body": "Do a. (selftest)",
    }],
    "deliveries": [],
}


def _hermes_available() -> bool:
    return os.environ.get("WC_REAL_HERMES") == "1" and shutil.which("hermes") is not None


@unittest.skipUnless(_hermes_available(), "set WC_REAL_HERMES=1 and install hermes to run")
class RealConductorTest(unittest.TestCase):
    def setUp(self):
        self.state = {"claimed": False, "cancel": False, "report": None}
        parent = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def ok(self):
                return self.headers.get("authorization") == "Bearer " + TOKEN

            def reply(self, c, o):
                b = json.dumps(o).encode()
                self.send_response(c)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                if not self.ok():
                    return self.reply(401, {})
                if self.path == "/api/conductor/pending":
                    runs = [] if parent.state["claimed"] else [{"runId": RUN, "workflowId": "w", "revision": 1, "bundle": BUNDLE}]
                    return self.reply(200, {"runs": runs})
                if self.path.endswith("/run/" + RUN):
                    return self.reply(200, {"runId": RUN, "status": "running", "cancelled": parent.state["cancel"], "stopped": False, "approvals": []})
                return self.reply(404, {})

            def do_POST(self):
                if not self.ok():
                    return self.reply(401, {})
                if self.path.endswith("/claim/" + RUN):
                    parent.state["claimed"] = True
                    return self.reply(200, {"claimed": True})
                if self.path.endswith("/report/" + RUN):
                    n = int(self.headers.get("content-length", 0))
                    parent.state["report"] = json.loads(self.rfile.read(n) or b"{}")
                    return self.reply(200, {"ok": True})
                return self.reply(404, {})

            def do_PUT(self):
                return self.reply(200, {"ok": True}) if self.ok() else self.reply(401, {})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.dir = tempfile.mkdtemp(prefix="wc-real-")
        self.env = {k: v for k, v in os.environ.items() if k != "HERMES_KANBAN_DB"}
        cfg = {
            "canvas_url": f"http://127.0.0.1:{self.port}", "token": TOKEN, "board": BOARD,
            "ledger_path": os.path.join(self.dir, "ledger.json"),
            "allowed_profiles": ["canvas-runner"], "allowed_skills": [],
            "hermes_bin": "hermes", "delivery_dir": os.path.join(self.dir, "deliveries"), "targets": {},
        }
        self.cfg_path = os.path.join(self.dir, "cfg.json")
        with open(self.cfg_path, "w") as h:
            json.dump(cfg, h)
        subprocess.run(["hermes", "kanban", "boards", "create", BOARD, "--name", "WC selftest"], env=self.env, capture_output=True, text=True)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        subprocess.run(["hermes", "kanban", "boards", "rm", BOARD, "--delete"], env=self.env, capture_output=True, text=True)
        shutil.rmtree(self.dir, ignore_errors=True)

    def tick(self):
        p = subprocess.run([sys.executable, "-I", CONDUCTOR, "--config", self.cfg_path, "tick"], env=self.env, capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)

    def tasks(self, archived=False):
        args = ["hermes", "kanban", "--board", BOARD, "list", "--json"] + (["--archived"] if archived else [])
        p = subprocess.run(args, env=self.env, capture_output=True, text=True)
        return json.loads(p.stdout or "[]")

    def test_real_tick_creates_reports_and_cancel_archives(self):
        self.tick()
        active = self.tasks()
        self.assertTrue(any(t["title"] == "wc selftest step a" for t in active), "step created on the named board")
        self.assertEqual(self.state["report"], {"runStatus": "running", "steps": [{"cardId": "a", "status": "created"}]})
        self.state["cancel"] = True
        self.tick()
        self.assertFalse(any(t["title"] == "wc selftest step a" for t in self.tasks()), "archived, not active")
        self.assertTrue(any(t["title"] == "wc selftest step a" and t["status"] == "archived" for t in self.tasks(archived=True)))


if __name__ == "__main__":
    unittest.main()
