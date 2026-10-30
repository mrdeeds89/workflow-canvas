import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SshTarget, Target } from "./config.ts";
import { JOB_ID_PATTERN, MAX_OBSERVATION_BYTES, OBSERVATION_FORMAT, OBSERVATION_VERSION, type PullOutcome } from "./observation.ts";

/**
 * Fetch one raw observation from a harness. Read-only by construction: the only
 * request ever sent is `snapshot <job_id>`, and the far side is a forced
 * command that can answer nothing else.
 */

export type FetchResult = { ok: true; raw: string; source: string } | { ok: false; outcome: Exclude<PullOutcome, "ok"> };

export type ObservationSource = (target: Target, jobId: string) => Promise<FetchResult>;

export const SSH_TIMEOUT_MS = 15_000;

/** Arguments for ssh. No shell is involved, and nothing here comes from a request. */
export function sshArgs(target: SshTarget, jobId: string): string[] {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error("refusing an invalid job id");
  return [
    "-F", "none",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${target.knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=8",
    "-o", "ClearAllForwardings=yes",
    "-o", "RequestTTY=no",
    "-i", target.identityFile,
    "-p", String(target.port),
    "-l", target.user,
    "--",
    target.host,
    `snapshot ${jobId}`,
  ];
}

/** Classify a failed ssh call without storing or returning its stderr. */
export function classifySshFailure(code: number | string | null, stderr: string, timedOut: boolean): Exclude<PullOutcome, "ok"> {
  if (timedOut) return "timeout";
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/i.test(stderr)) {
    return "host_key_mismatch";
  }
  if (/Permission denied/i.test(stderr)) return "auth_refused";
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output_too_large";
  return "unreachable";
}

function fromSsh(target: SshTarget, jobId: string): Promise<FetchResult> {
  return new Promise((done) => {
    execFile(
      "ssh",
      sshArgs(target, jobId),
      { timeout: SSH_TIMEOUT_MS, maxBuffer: MAX_OBSERVATION_BYTES, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
      (error, stdout, stderr) => {
        if ((error as { code?: unknown } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          done({ ok: false, outcome: "output_too_large" });
          return;
        }
        // The exporter exits non-zero for refusals but still prints a JSON observation.
        const output = typeof stdout === "string" ? stdout.trim() : "";
        if (output.startsWith("{")) {
          done({ ok: true, raw: output, source: "ssh-pull" });
          return;
        }
        if (!error) {
          done({ ok: false, outcome: "bad_output" });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string };
        const exitCode = typeof failure.code === "number" ? failure.code : null;
        const timedOut = failure.killed === true && failure.signal === "SIGTERM";
        if (exitCode !== null && exitCode !== 255) {
          done({ ok: false, outcome: "bad_output" });
          return;
        }
        done({ ok: false, outcome: classifySshFailure(failure.code ?? null, String(stderr ?? ""), timedOut) });
      },
    );
  });
}

const TIME_KEYS = new Set([
  "observed_at", "next_run_at", "last_run_at", "paused_at",
  "scheduled_instant", "claimed_at", "started_at", "finished_at", "progress_at",
]);

/** Move every timestamp by the same amount, so observed_at becomes `now`. */
export function shiftTimes(value: unknown, now: number): unknown {
  const root = value as { observed_at?: unknown };
  const base = typeof root?.observed_at === "string" ? Date.parse(root.observed_at) : Number.NaN;
  if (Number.isNaN(base)) return value;
  const delta = now - base;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== "object" || node === null) return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, item]) => {
        if (TIME_KEYS.has(key) && typeof item === "string" && !Number.isNaN(Date.parse(item))) {
          return [key, new Date(Date.parse(item) + delta).toISOString().replace(/\.\d{3}Z$/, "Z")];
        }
        return [key, walk(item)];
      }),
    );
  };
  return walk(value);
}

async function fromFixture(target: Extract<Target, { transport: "fixture-dir" }>, jobId: string, now: number): Promise<FetchResult> {
  if (!JOB_ID_PATTERN.test(jobId)) return { ok: false, outcome: "bad_output" };
  const source = target.shiftTimesToNow ? "example-fixture (times shifted to now)" : "example-fixture";
  let text: string;
  try {
    text = await readFile(join(target.directory, target.profile, `${jobId}.json`), "utf8");
  } catch {
    const missing = {
      format: OBSERVATION_FORMAT,
      version: OBSERVATION_VERSION,
      observed_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
      harness: { hermes_version: null, exporter_version: "fixture", profile: target.profile },
      error: { code: "not_found" },
    };
    return { ok: true, raw: JSON.stringify(missing), source };
  }
  if (Buffer.byteLength(text) > MAX_OBSERVATION_BYTES) return { ok: false, outcome: "output_too_large" };
  if (!target.shiftTimesToNow) return { ok: true, raw: text, source };
  try {
    return { ok: true, raw: JSON.stringify(shiftTimes(JSON.parse(text) as unknown, now)), source };
  } catch {
    return { ok: false, outcome: "bad_output" };
  }
}

export function defaultSource(now: () => number = Date.now): ObservationSource {
  return (target, jobId) => (target.transport === "ssh" ? fromSsh(target, jobId) : fromFixture(target, jobId, now()));
}
