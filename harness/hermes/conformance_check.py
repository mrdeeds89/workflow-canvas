#!/usr/bin/env python3
"""Compare the exporter's displayed-state rule with Hermes's own.

Run on a machine with Hermes installed, with Hermes's own interpreter, before
adding a Hermes release to SUPPORTED_HERMES_SERIES:

    HERMES_HOME="$(mktemp -d)" <hermes-venv>/bin/python -I conformance_check.py <hermes-install-dir>

HERMES_HOME must point at an empty throwaway directory. Importing Hermes
seeds files into whatever home it is given, so never run this against a real
one. Reads no job store. Exit 0 when every fixture agrees.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    home = os.environ.get("HERMES_HOME", "")
    if not home or any(Path(home).iterdir()):
        print("Set HERMES_HOME to an empty throwaway directory first.")
        return 2
    sys.path.insert(0, str(HERE))
    sys.path.insert(0, sys.argv[1])
    import workflow_canvas_exporter as exporter  # noqa: E402
    from cron.jobs import effective_job_state, is_job_runnable  # noqa: E402

    fixtures = json.loads((HERE / "state-fixtures.json").read_text(encoding="utf-8"))
    failures = 0
    for fixture in fixtures:
        job = fixture["job"]
        ours = (exporter.effective_job_state(job), exporter.is_job_runnable(job))
        theirs = (effective_job_state(dict(job)), is_job_runnable(dict(job)))
        recorded = (fixture["expect"]["display_state"], fixture["expect"]["runnable"])
        agree = ours == theirs == recorded
        failures += not agree
        print(f"{'ok  ' if agree else 'FAIL'} {fixture['case']}: exporter={ours} hermes={theirs} recorded={recorded}")
    print(f"{len(fixtures) - failures}/{len(fixtures)} agree")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
