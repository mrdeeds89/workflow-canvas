import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CLOCK_SKEW_MS,
  DEFAULT_THRESHOLDS,
  describeEvidence,
  lookup,
  OBSERVATION_FORMAT,
  OBSERVATION_VERSION,
  parseObservation,
  type LinkView,
  type Observation,
  type StoredObservation,
} from "../src/harness/observation.ts";

const EXAMPLES = join(import.meta.dirname, "..", "examples", "hermes-observations", "example");

function example(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(EXAMPLES, `${id}.json`), "utf8")) as Record<string, unknown>;
}

function parsed(raw: unknown): Observation {
  const result = parseObservation(raw);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.value;
}

const DIGEST = "a1b2c3d4e5f6";
const DISK = "b2c3d4e5f6a7";
const READING = "c3d4e5f6a7b8";

function link(over: Partial<LinkView> = {}): LinkView {
  return {
    harness: "examples",
    profile: "example",
    jobId: DIGEST,
    linkedAt: 0,
    linkedFingerprint: null,
    lastAttemptAt: null,
    lastAttemptOutcome: "ok",
    ...over,
  };
}

/** A stored observation received at `receivedAt`, with observed_at equal to it unless given. */
function stored(raw: Record<string, unknown>, receivedAt: number, observedAt = receivedAt): StoredObservation {
  return {
    observation: parsed({ ...raw, observed_at: new Date(observedAt).toISOString() }),
    receivedAt,
    source: "test",
  };
}

function withJob(raw: Record<string, unknown>, change: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, job: { ...(raw.job as Record<string, unknown>), ...change } };
}

const NOW = Date.parse("2026-10-30T12:00:00Z");

function codes(evidence: ReturnType<typeof describeEvidence>): string[] {
  return evidence.flags.map((flag) => flag.code);
}

test("the three public examples parse", () => {
  for (const id of [DIGEST, DISK, READING]) {
    const value = parsed(example(id));
    assert.equal(value.kind, "job");
    if (value.kind === "job") assert.equal(value.job.jobId, id);
  }
});

test("unknown fields are dropped before storage, including prompt text sent by mistake", () => {
  const raw = example(DIGEST);
  const value = parsed({
    ...raw,
    prompt: "SECRET PROMPT",
    job: { ...(raw.job as object), prompt: "SECRET PROMPT", deliver: "telegram:-100123", script: "/home/x/run.sh" },
    executions: [{ ...((raw.executions as object[])[0] as object), error: "token=abc", pid: 42 }],
  });
  const text = JSON.stringify(value);
  for (const leak of ["SECRET PROMPT", "-100123", "/home/x", "token=abc", "\"pid\""]) {
    assert.ok(!text.includes(leak), `${leak} survived parsing`);
  }
});

test("malformed observations are refused with a reason", () => {
  const raw = example(DIGEST);
  const cases: [string, unknown][] = [
    ["not an object", "hello"],
    ["wrong format", { ...raw, format: "something-else" }],
    ["future version", { ...raw, version: OBSERVATION_VERSION + 1 }],
    ["missing observed_at", { ...raw, observed_at: null }],
    ["bad job id", withJob(raw, { job_id: "../../etc" })],
    ["status that is not a word", withJob(raw, { last_status: "<b>ok</b>" })],
    ["name too long", withJob(raw, { name: "x".repeat(201) })],
    ["enabled as text", withJob(raw, { enabled: "true" })],
    ["bad timestamp", withJob(raw, { next_run_at: "tomorrow" })],
    ["negative heartbeat", { ...raw, scheduler: { ticker_heartbeat_age_s: -1 } }],
    ["too many executions", { ...raw, executions: Array.from({ length: 11 }, () => (raw.executions as unknown[])[0]) }],
  ];
  for (const [name, value] of cases) {
    const result = parseObservation(value);
    assert.equal(result.ok, false, name);
  }
  assert.equal(OBSERVATION_FORMAT, raw.format);
});

test("a refusal from the harness parses as its own kind", () => {
  const value = parsed({
    format: OBSERVATION_FORMAT,
    version: OBSERVATION_VERSION,
    observed_at: "2026-10-30T12:00:00Z",
    harness: { hermes_version: "0.23.0", exporter_version: "0.1.0", profile: "lab" },
    error: { code: "unsupported_version" },
  });
  assert.deepEqual(value.kind === "refused" && value.code, "unsupported_version");
});

test("fresh healthy job: whole-job result, no warnings", () => {
  const latest = stored(example(DIGEST), NOW - 60_000);
  const evidence = describeEvidence(link(), latest, latest, NOW);
  assert.equal(evidence.fresh, true);
  assert.deepEqual(codes(evidence), []);
  assert.equal(evidence.result?.code, "ok");
  assert.match(evidence.result?.text ?? "", /delivery confirmed/);
});

test("each last_status literal has its own wording and none but ok reads as success", () => {
  const expected: Record<string, [string, string]> = {
    ok: ["ok", "ok"],
    delivery_queued: ["delivery_queued", "info"],
    delivery_failed: ["delivery_failed", "bad"],
    error: ["error", "bad"],
    blocked_config: ["blocked_config", "bad"],
    teleported: ["unrecognized", "warn"],
  };
  for (const [status, [code, tone]] of Object.entries(expected)) {
    const raw = withJob({ ...example(DIGEST), executions: [] }, { last_status: status });
    const latest = stored(raw, NOW);
    const evidence = describeEvidence(link(), latest, latest, NOW);
    assert.equal(evidence.result?.code, code, status);
    assert.equal(evidence.result?.tone, tone, status);
  }
  const never = stored(withJob({ ...example(DIGEST), executions: [] }, { last_status: null }), NOW);
  assert.equal(describeEvidence(link(), never, never, NOW).result?.code, "never_run");
});

test("an unrecognized status is flagged and never counted as success", () => {
  const latest = stored(withJob({ ...example(DIGEST), executions: [] }, { last_status: "teleported" }), NOW);
  const evidence = describeEvidence(link(), latest, latest, NOW);
  assert.ok(codes(evidence).includes("unrecognized_status"));
  assert.notEqual(evidence.result?.tone, "ok");
});

test("a running attempt and an owner-lost attempt are reported from the ledger", () => {
  const raw = example(DIGEST);
  const first = (raw.executions as Record<string, unknown>[])[0]!;
  const running = stored({ ...raw, executions: [{ ...first, status: "running", finished_at: null }] }, NOW);
  const r = describeEvidence(link(), running, running, NOW);
  assert.equal(r.result?.code, "running");
  assert.ok(codes(r).includes("running"));

  const lost = stored({ ...raw, executions: [{ ...first, status: "unknown" }] }, NOW);
  const l = describeEvidence(link(), lost, lost, NOW);
  assert.equal(l.result?.code, "unknown");
  assert.notEqual(l.result?.tone, "ok");
});

test("stale after the threshold, measured from this server's receive time", () => {
  const latest = stored(example(DIGEST), NOW - DEFAULT_THRESHOLDS.staleAfterMs - 1);
  const evidence = describeEvidence(link(), latest, latest, NOW);
  assert.equal(evidence.fresh, false);
  assert.ok(codes(evidence).includes("stale"));
});

test("never observed", () => {
  const evidence = describeEvidence(link({ lastAttemptOutcome: null }), null, null, NOW);
  assert.deepEqual(codes(evidence), ["never_observed"]);
  assert.equal(evidence.result, null);
});

test("disconnected keeps the last observation and says it is not current", () => {
  const latest = stored(example(DIGEST), NOW - 30_000);
  const evidence = describeEvidence(link({ lastAttemptOutcome: "unreachable" }), latest, latest, NOW);
  const flag = evidence.flags.find((item) => item.code === "disconnected");
  assert.ok(flag);
  assert.match(flag.text, /not the current state/);
  assert.equal(evidence.result?.code, "ok", "the last known result is still shown, labelled by the flag");
});

test("job not found and unsupported version are flagged from a refusal", () => {
  const refusal = (code: string, version: string | null) =>
    ({
      observation: parsed({
        format: OBSERVATION_FORMAT,
        version: OBSERVATION_VERSION,
        observed_at: new Date(NOW).toISOString(),
        harness: { hermes_version: version, exporter_version: "0.1.0", profile: "example" },
        error: { code },
      }),
      receivedAt: NOW,
      source: "test",
    }) satisfies StoredObservation;
  const lastJob = stored(example(DIGEST), NOW - 3_600_000);
  const gone = describeEvidence(link(), lastJob, refusal("not_found", "0.22.5"), NOW);
  assert.ok(codes(gone).includes("not_found"));
  assert.equal(gone.job?.job.jobId, DIGEST, "the last known job state is kept for reference");

  const upgraded = describeEvidence(link(), null, refusal("unsupported_version", "0.23.0"), NOW);
  const flag = upgraded.flags.find((item) => item.code === "unsupported");
  assert.ok(flag);
  assert.match(flag.text, /0\.23\.0/);
});

test("harness clock ahead of this server is called out", () => {
  const ahead = stored(example(DIGEST), NOW, NOW + CLOCK_SKEW_MS + 60_000);
  assert.ok(codes(describeEvidence(link(), ahead, ahead, NOW)).includes("clock_skew"));
  const close = stored(example(DIGEST), NOW, NOW + 30_000);
  assert.ok(!codes(describeEvidence(link(), close, close, NOW)).includes("clock_skew"));
  const aheadEvidence = describeEvidence(link(), ahead, ahead, NOW + 60_000);
  assert.equal(aheadEvidence.ageMs, 60_000, "a harness clock ahead cannot make data look newer");
});

test("an observation made long before it arrived is treated as old, not fresh", () => {
  const old = stored(example(DIGEST), NOW, NOW - 90 * 24 * 3_600_000);
  const evidence = describeEvidence(link(), old, old, NOW);
  assert.equal(evidence.fresh, false);
  assert.ok(codes(evidence).includes("stale"));
  assert.ok(codes(evidence).includes("observed_long_before_received"));
  assert.equal(evidence.ageMs, 90 * 24 * 3_600_000);
});

test("a silent or missing scheduler heartbeat is flagged", () => {
  const silent = stored({ ...example(DIGEST), scheduler: { ticker_heartbeat_age_s: 600 } }, NOW);
  assert.ok(codes(describeEvidence(link(), silent, silent, NOW)).includes("scheduler_silent"));
  const missing = stored({ ...example(DIGEST), scheduler: { ticker_heartbeat_age_s: null } }, NOW);
  assert.ok(codes(describeEvidence(link(), missing, missing, NOW)).includes("scheduler_unknown"));
});

test("overdue only for a runnable scheduled job well past its next run", () => {
  const observed = NOW;
  const past = new Date(observed - 10 * 60_000).toISOString();
  const overdue = stored(withJob(example(DIGEST), { next_run_at: past }), NOW, observed);
  assert.ok(codes(describeEvidence(link(), overdue, overdue, NOW)).includes("overdue"));
  const paused = stored(example(READING), NOW);
  assert.ok(!codes(describeEvidence(link({ jobId: READING }), paused, paused, NOW)).includes("overdue"));
});

test("paused, and scheduled-but-will-not-fire, are distinct", () => {
  const paused = stored(example(READING), NOW);
  assert.ok(codes(describeEvidence(link({ jobId: READING }), paused, paused, NOW)).includes("paused"));

  const halfPaused = stored(withJob(example(DIGEST), { display_state: "scheduled", runnable: false }), NOW);
  const evidence = describeEvidence(link(), halfPaused, halfPaused, NOW);
  assert.ok(codes(evidence).includes("will_not_fire"));
  assert.ok(!codes(evidence).includes("paused"));
});

test("a changed definition since linking is flagged", () => {
  const latest = stored(example(DIGEST), NOW);
  assert.ok(codes(describeEvidence(link({ linkedFingerprint: "f".repeat(64) }), latest, latest, NOW)).includes("definition_changed"));
  assert.ok(!codes(describeEvidence(link({ linkedFingerprint: "1".repeat(64) }), latest, latest, NOW)).includes("definition_changed"));
});

test("a fresh refusal does not make old job details look fresh", () => {
  const oldJob = stored(example(DIGEST), NOW - 3 * 24 * 3_600_000);
  const refusal: StoredObservation = {
    observation: parsed({
      format: OBSERVATION_FORMAT,
      version: OBSERVATION_VERSION,
      observed_at: new Date(NOW - 5_000).toISOString(),
      harness: { hermes_version: "0.22.5", exporter_version: "0.1.0", profile: "example" },
      error: { code: "not_found" },
    }),
    receivedAt: NOW - 5_000,
    source: "test",
  };
  const evidence = describeEvidence(link(), oldJob, refusal, NOW);
  assert.equal(evidence.ageMs, 5_000, "the newest check is recent");
  assert.equal(evidence.jobAgeMs, 3 * 24 * 3_600_000, "the job details are three days old");
  assert.equal(evidence.fresh, false);
  assert.ok(codes(evidence).includes("stale"));
  assert.ok(codes(evidence).includes("not_found"));
  assert.match(evidence.flags.find((flag) => flag.code === "stale")?.text ?? "", /job details/);
});

test("inherited property names are unrecognized statuses, never table entries", () => {
  for (const status of ["constructor", "tostring", "valueof", "hasownproperty", "__proto__"]) {
    const raw = withJob({ ...example(DIGEST), executions: [] }, { last_status: status });
    const result = parseObservation(raw);
    if (!result.ok) continue; // "__proto__" is not a plain word and is refused outright
    const latest: StoredObservation = { observation: result.value, receivedAt: NOW, source: "test" };
    const evidence = describeEvidence(link(), latest, latest, NOW);
    assert.equal(evidence.result?.code, "unrecognized", status);
    assert.equal(typeof evidence.result?.text, "string", status);
    assert.ok(codes(evidence).includes("unrecognized_status"), status);
  }
  assert.equal(lookup({ ok: 1 }, "constructor"), undefined);
  assert.equal(lookup({ ok: 1 }, "ok"), 1);
});

test("a delivery failure is not success, even though the job itself ran", () => {
  const latest = stored(example(DISK), NOW);
  const evidence = describeEvidence(link({ jobId: DISK }), latest, latest, NOW);
  assert.equal(evidence.result?.code, "delivery_failed");
  assert.equal(evidence.result?.tone, "bad");
});
