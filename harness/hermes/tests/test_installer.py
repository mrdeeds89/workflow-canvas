#!/usr/bin/env python3
"""Installer tests for the conductor, against a stub Canvas and fake hermes.

Hermetic: no real Hermes, no real profile/board/cron. The stub answers the
pairing exchange; fake_hermes.py records every CLI call. Proves dry-run makes
nothing, a full install writes the config (mode 600), the profile config, the
wrapper, and issues the right hermes commands, and uninstall removes the cron,
wrapper and config while leaving the board.

Run:  python3 -I harness/hermes/tests/test_installer.py
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CONDUCTOR = os.path.join(os.path.dirname(HERE), "workflow_canvas_conductor.py")
FAKE_HERMES = os.path.join(HERE, "fake_hermes.py")
GOOD_CODE = "ABCD-2345"
TOKEN = "install-token-" + "0" * 40


def make_handler():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path == "/api/conductor/pair":
                n = int(self.headers.get("content-length", 0))
                code = json.loads(self.rfile.read(n) or b"{}").get("code")
                if code == GOOD_CODE:
                    return self._send(201, {"connectionId": "c1", "token": TOKEN})
                return self._send(403, {"error": "pairing_failed"})
            return self._send(404, {})

        def do_DELETE(self):
            if self.path == "/api/connection":
                return self._send(204, {})
            return self._send(404, {})

    return Handler


class InstallerTest(unittest.TestCase):
    def setUp(self):
        os.chmod(FAKE_HERMES, 0o755)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler())
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.dir = tempfile.mkdtemp(prefix="wc-install-")
        self.home = os.path.join(self.dir, "hermes-home")
        self.config = os.path.join(self.dir, "conf", "conductor.json")
        self.cmdlog = os.path.join(self.dir, "cmdlog.jsonl")
        self.wrapper = os.path.join(self.home, "scripts", "workflow-canvas-conductor.sh")
        self.profile_cfg = os.path.join(self.home, "profiles", "canvas-runner", "config.yaml")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_conductor(self, *args):
        env = dict(os.environ, FAKE_HERMES_BOARD=os.path.join(self.dir, "board.json"), FAKE_HERMES_CMDLOG=self.cmdlog)
        return subprocess.run([sys.executable, "-I", CONDUCTOR, *args], capture_output=True, text=True, env=env)

    def install_args(self, code=GOOD_CODE, extra=()):
        return [
            "--config", self.config, "install",
            "--canvas", f"http://127.0.0.1:{self.port}", "--pair", code,
            "--hermes-home", self.home, "--hermes-bin", FAKE_HERMES, *extra,
        ]

    def cmds(self):
        if not os.path.exists(self.cmdlog):
            return []
        with open(self.cmdlog) as h:
            return [json.loads(l) for l in h if l.strip()]

    def test_dry_run_changes_nothing(self):
        p = self.run_conductor(*self.install_args(extra=["--dry-run"]))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("dry-run", p.stdout)
        self.assertFalse(os.path.exists(self.config), "no config in dry-run")
        self.assertFalse(os.path.exists(self.wrapper), "no wrapper in dry-run")
        self.assertEqual(self.cmds(), [], "no hermes calls in dry-run")

    def test_full_install_writes_everything_and_calls_hermes(self):
        p = self.run_conductor(*self.install_args(extra=["--yes"]))
        self.assertEqual(p.returncode, 0, p.stderr)
        # config (mode 600) with the token and allowlist
        self.assertTrue(os.path.exists(self.config))
        self.assertEqual(stat.S_IMODE(os.stat(self.config).st_mode), 0o600)
        cfg = json.load(open(self.config))
        self.assertEqual(cfg["token"], TOKEN)
        self.assertEqual(cfg["board"], "workflow-canvas")
        self.assertEqual(cfg["allowed_profiles"], ["canvas-runner"])
        self.assertEqual(cfg["allowed_skills"], [])
        # profile config with docker backend (credential isolation)
        self.assertIn("backend: docker", open(self.profile_cfg).read())
        # wrapper is executable
        self.assertTrue(os.access(self.wrapper, os.X_OK))
        # hermes commands issued
        cmds = self.cmds()
        self.assertTrue(any(c[:3] == ["profile", "create", "canvas-runner"] for c in cmds), cmds)
        self.assertTrue(any("boards" in c and "create" in c and "workflow-canvas" in c for c in cmds), cmds)
        cron = [c for c in cmds if c[:2] == ["cron", "create"]][0]
        self.assertIn("--no-agent", cron)
        self.assertIn("--deliver", cron)
        self.assertIn("local", cron)
        self.assertIn(self.wrapper, cron)

    def test_bad_code_makes_no_changes(self):
        p = self.run_conductor(*self.install_args(code="WRONG-9999", extra=["--yes"]))
        self.assertEqual(p.returncode, 1)
        self.assertFalse(os.path.exists(self.config))
        self.assertEqual(self.cmds(), [], "no profile/board/cron created when pairing fails")

    def test_allow_profile_and_skill(self):
        self.run_conductor(*self.install_args(extra=["--yes"]))
        self.run_conductor("--config", self.config, "allow-profile", "other-runner")
        self.run_conductor("--config", self.config, "allow-skill", "daily-digest")
        cfg = json.load(open(self.config))
        self.assertIn("other-runner", cfg["allowed_profiles"])
        self.assertIn("daily-digest", cfg["allowed_skills"])
        self.assertEqual(stat.S_IMODE(os.stat(self.config).st_mode), 0o600)

    def test_uninstall_removes_config_and_cron_keeps_board(self):
        self.run_conductor(*self.install_args(extra=["--yes"]))
        self.assertTrue(os.path.exists(self.config))
        open(self.cmdlog, "w").close()  # clear the install calls
        p = self.run_conductor("--config", self.config, "uninstall", "--hermes-home", self.home)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertFalse(os.path.exists(self.config), "config removed")
        self.assertFalse(os.path.exists(self.wrapper), "wrapper removed")
        cmds = self.cmds()
        self.assertTrue(any(c[:2] == ["cron", "remove"] for c in cmds), cmds)
        self.assertFalse(any("boards" in c and ("rm" in c or "delete" in c) for c in cmds), "the board is kept")


if __name__ == "__main__":
    unittest.main()
