# Hermes exporter

`workflow_canvas_exporter.py` lets a Workflow Canvas server see one Hermes cron job: its schedule, whether it is paused, its latest whole-job result, and its recent attempts. It is read-only. It cannot create, edit, pause, resume, run, or delete a job. The contract is in `docs/HERMES-INTEGRATION.md`.

It is one standard-library Python file. It does not import Hermes and opens the cron store read-only. It never creates, changes, or removes a file under the Hermes home. It prints one JSON observation and exits.

Never printed: prompt text, delivery chat/channel IDs, script paths, working directories, model, provider or base URL, monitor URLs, error text, run output, process IDs, and credentials.

Checked against Hermes **0.22.x**. Any other release answers `unsupported_version` until it has been checked (below).

## Try it by hand

On the Hermes host, as the user that runs Hermes:

```bash
python3 -I workflow_canvas_exporter.py --profile default snapshot <job_id>
```

`<job_id>` comes from `hermes cron list`. For a named profile, use `--profile <name>`. Exit codes: `0` ok, `2` bad request, `3` job not found, `4` unsupported Hermes version or store layout, `5` store unreadable. Each still prints a JSON refusal on stdout.

## Install for a Canvas server (one key per profile)

Every step here changes the Hermes host. Back up `~/.ssh/authorized_keys` first.

1. Copy the exporter to a path the Hermes user can read but the key cannot change, for example `/opt/wc-exporter/workflow_canvas_exporter.py`, mode `0755`, owned by root.
2. On the **Canvas server**, make one key per observed profile. The private key never leaves that server:

   ```bash
   ssh-keygen -t ed25519 -N '' -C 'workflow-canvas <harness>/<profile>' -f <private-dir>/keys/<harness>-<profile>
   ```

3. On the **Hermes host**, append one line per key to the Hermes user's `~/.ssh/authorized_keys`. The profile is fixed here and cannot be chosen by the caller:

   ```text
   restrict,command="/usr/bin/python3 -I /opt/wc-exporter/workflow_canvas_exporter.py --profile <profile>" ssh-ed25519 AAAA... workflow-canvas <harness>/<profile>
   ```

   `restrict` turns off PTY, port, agent and X11 forwarding. The forced command ignores whatever the caller asks to run. The exporter then accepts exactly `snapshot <job_id>`.

4. On the **Canvas server**, record the host key once, after checking its fingerprint out of band:

   ```bash
   ssh-keyscan -t ed25519 <host> > <private-dir>/known_hosts
   ssh-keygen -lf <private-dir>/known_hosts
   ```

5. Write the private harness config. Start from `examples/hermes-observations/harness-config.ssh.template.json`, and keep it outside the repository. Point `WORKFLOW_CANVAS_HARNESS_CONFIG` at it. If the server runs in a container, mount the private directory read-only.

6. Check from the Canvas server that the key does its one thing and nothing else:

   ```bash
   K=<private-dir>/keys/<harness>-<profile>
   O="-F none -o BatchMode=yes -o IdentitiesOnly=yes -o UserKnownHostsFile=<private-dir>/known_hosts"
   ssh $O -i $K <user>@<host> snapshot <job_id>      # one JSON observation
   ssh $O -i $K <user>@<host> id                     # {"error":{"code":"bad_request"}}
   ssh $O -i $K -tt <user>@<host> snapshot <job_id>  # no PTY is granted
   ssh $O -i $K -N -L 9999:127.0.0.1:22 <user>@<host> # port forwarding refused
   ```

To remove access, delete that line from `authorized_keys`. Nothing else on the Hermes host changed.

## Before trusting a new Hermes release

1. Run the conformance check with Hermes's own interpreter and an **empty throwaway** `HERMES_HOME`. Importing Hermes seeds files into whatever home it is given:

   ```bash
   HERMES_HOME="$(mktemp -d)" <hermes-install>/venv/bin/python -I conformance_check.py <hermes-install>
   ```

   It compares the exporter's displayed-state rule, the recorded expectations in `state-fixtures.json`, and Hermes itself. All must agree.

2. Run the Node tests (`npm test`), including `test/harness-exporter.test.ts`.
3. Only then add the release series to `SUPPORTED_HERMES_SERIES`.
