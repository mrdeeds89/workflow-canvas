/**
 * Read-only observations of a Hermes cron job, and what the panel may say about them.
 *
 * Shared by the server and the browser, so no Node imports. An observation is
 * evidence copied from another system. Every string in it is untrusted text:
 * it is shown, never run, parsed as markup, or sent anywhere.
 *
 * The parser copies allowlisted fields into a fresh object. Anything else the
 * harness sent, such as prompt text by mistake, is dropped before storage.
 */

export const OBSERVATION_FORMAT = "workflow-canvas.hermes-observation";
export const OBSERVATION_VERSION = 1;
export const MAX_OBSERVATION_BYTES = 256 * 1024;
export const JOB_ID_PATTERN = /^[0-9a-f]{6,32}$/;
export const LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type ExecutionRecord = {
  id: string;
  status: string | null;
  source: string | null;
  scheduledInstant: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  progressAt: string | null;
  deliveryOutcome: string | null;
};

export type JobFingerprint = {
  definitionSha256: string;
  skills: string[];
  scriptPresent: boolean;
  noAgent: boolean;
  modelPinned: boolean;
};

export type JobState = {
  jobId: string;
  name: string;
  schedule: { kind: string | null; display: string | null };
  timezone: string | null;
  displayState: string | null;
  enabled: boolean;
  runnable: boolean;
  pausedAt: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  hasErrorDetail: boolean;
  deliveryKinds: string[];
  fingerprint: JobFingerprint;
};

export type HarnessInfo = {
  hermesVersion: string | null;
  exporterVersion: string | null;
  profile: string | null;
};

export type Observation =
  | {
      kind: "job";
      observedAt: string;
      harness: HarnessInfo;
      tickerHeartbeatAgeS: number | null;
      job: JobState;
      executionsAvailable: boolean;
      executions: ExecutionRecord[];
    }
  | { kind: "refused"; observedAt: string; harness: HarnessInfo; code: string };

export type ParseResult = { ok: true; value: Observation } | { ok: false; reason: string };

class Invalid extends Error {}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Invalid(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function str(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new Invalid(`${path} must be text of at most ${max} characters`);
  return value;
}

function optStr(value: unknown, path: string, max: number): string | null {
  return value === null || value === undefined ? null : str(value, path, max);
}

const WORD = /^[a-z][a-z0-9_]{0,39}$/;

function optWord(value: unknown, path: string): string | null {
  const text = optStr(value, path, 40);
  if (text !== null && !WORD.test(text)) throw new Invalid(`${path} must be a lowercase word`);
  return text;
}

function optTime(value: unknown, path: string): string | null {
  const text = optStr(value, path, 40);
  if (text !== null && Number.isNaN(Date.parse(text))) throw new Invalid(`${path} must be a timestamp`);
  return text;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Invalid(`${path} must be true or false`);
  return value;
}

function strList(value: unknown, path: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Invalid(`${path} must be a list of at most ${maxItems}`);
  return value.map((item, index) => str(item, `${path}[${index}]`, maxLength));
}

function harnessInfo(value: unknown): HarnessInfo {
  const raw = record(value, "harness");
  return {
    hermesVersion: optStr(raw.hermes_version, "harness.hermes_version", 32),
    exporterVersion: optStr(raw.exporter_version, "harness.exporter_version", 32),
    profile: optStr(raw.profile, "harness.profile", 64),
  };
}

function execution(value: unknown, index: number): ExecutionRecord {
  const path = `executions[${index}]`;
  const raw = record(value, path);
  return {
    id: str(raw.id, `${path}.id`, 64),
    status: optWord(raw.status, `${path}.status`),
    source: optWord(raw.source, `${path}.source`),
    scheduledInstant: optTime(raw.scheduled_instant, `${path}.scheduled_instant`),
    claimedAt: optTime(raw.claimed_at, `${path}.claimed_at`),
    startedAt: optTime(raw.started_at, `${path}.started_at`),
    finishedAt: optTime(raw.finished_at, `${path}.finished_at`),
    progressAt: optTime(raw.progress_at, `${path}.progress_at`),
    deliveryOutcome: optWord(raw.delivery_outcome, `${path}.delivery_outcome`),
  };
}

function jobState(value: unknown): JobState {
  const raw = record(value, "job");
  const schedule = record(raw.schedule, "job.schedule");
  const print = record(raw.fingerprint, "job.fingerprint");
  const jobId = str(raw.job_id, "job.job_id", 32);
  if (!JOB_ID_PATTERN.test(jobId)) throw new Invalid("job.job_id is not a job id");
  const sha = str(print.definition_sha256, "job.fingerprint.definition_sha256", 64);
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Invalid("job.fingerprint.definition_sha256 is not a sha256");
  return {
    jobId,
    name: str(raw.name, "job.name", 200),
    schedule: {
      kind: optWord(schedule.kind, "job.schedule.kind"),
      display: optStr(schedule.display, "job.schedule.display", 120),
    },
    timezone: optStr(raw.timezone, "job.timezone", 64),
    displayState: optWord(raw.display_state, "job.display_state"),
    enabled: bool(raw.enabled, "job.enabled"),
    runnable: bool(raw.runnable, "job.runnable"),
    pausedAt: optTime(raw.paused_at, "job.paused_at"),
    nextRunAt: optTime(raw.next_run_at, "job.next_run_at"),
    lastRunAt: optTime(raw.last_run_at, "job.last_run_at"),
    lastStatus: optWord(raw.last_status, "job.last_status"),
    hasErrorDetail: bool(raw.has_error_detail, "job.has_error_detail"),
    deliveryKinds: strList(raw.delivery_kinds, "job.delivery_kinds", 8, 32),
    fingerprint: {
      definitionSha256: sha,
      skills: strList(print.skills, "job.fingerprint.skills", 20, 80),
      scriptPresent: bool(print.script_present, "job.fingerprint.script_present"),
      noAgent: bool(print.no_agent, "job.fingerprint.no_agent"),
      modelPinned: bool(print.model_pinned, "job.fingerprint.model_pinned"),
    },
  };
}

/** Validate exporter output. Only allowlisted fields survive. */
export function parseObservation(value: unknown): ParseResult {
  try {
    const raw = record(value, "observation");
    if (raw.format !== OBSERVATION_FORMAT) throw new Invalid("not a Workflow Canvas Hermes observation");
    if (raw.version !== OBSERVATION_VERSION) throw new Invalid(`unsupported observation version ${String(raw.version)}`);
    const observedAt = optTime(raw.observed_at, "observed_at");
    if (observedAt === null) throw new Invalid("observed_at is required");
    const harness = harnessInfo(raw.harness);
    if (raw.error !== undefined) {
      const error = record(raw.error, "error");
      const code = optWord(error.code, "error.code");
      if (code === null) throw new Invalid("error.code is required");
      return { ok: true, value: { kind: "refused", observedAt, harness, code } };
    }
    const scheduler = record(raw.scheduler, "scheduler");
    const age = scheduler.ticker_heartbeat_age_s;
    if (age !== null && (typeof age !== "number" || !Number.isFinite(age) || age < 0)) {
      throw new Invalid("scheduler.ticker_heartbeat_age_s must be a number of seconds or null");
    }
    if (!Array.isArray(raw.executions) || raw.executions.length > 10) throw new Invalid("executions must be a list of at most 10");
    return {
      ok: true,
      value: {
        kind: "job",
        observedAt,
        harness,
        tickerHeartbeatAgeS: age,
        job: jobState(raw.job),
        executionsAvailable: bool(raw.executions_available, "executions_available"),
        executions: raw.executions.map(execution),
      },
    };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, reason: error.message };
    throw error;
  }
}

// --- What the panel says ---------------------------------------------------------

export type Thresholds = { staleAfterMs: number; heartbeatSilentS: number };
export const DEFAULT_THRESHOLDS: Thresholds = { staleAfterMs: 15 * 60_000, heartbeatSilentS: 180 };
/** How far a harness clock may run ahead of this server before it is called out. */
export const CLOCK_SKEW_MS = 2 * 60_000;
/** A scheduled job this far past its next run, while the scheduler ticks, is overdue. */
export const OVERDUE_MS = 5 * 60_000;

export type PullOutcome =
  | "ok"
  | "unreachable"
  | "timeout"
  | "auth_refused"
  | "host_key_mismatch"
  | "bad_output"
  | "output_too_large"
  | "not_configured";

export type StoredObservation = { observation: Observation; receivedAt: number; source: string };

export type LinkView = {
  harness: string;
  profile: string;
  jobId: string;
  linkedAt: number;
  linkedFingerprint: string | null;
  lastAttemptAt: number | null;
  lastAttemptOutcome: PullOutcome | null;
};

export type FlagCode =
  | "never_observed"
  | "stale"
  | "disconnected"
  | "not_found"
  | "unsupported"
  | "refused"
  | "clock_skew"
  | "observed_long_before_received"
  | "scheduler_silent"
  | "scheduler_unknown"
  | "overdue"
  | "paused"
  | "will_not_fire"
  | "running"
  | "definition_changed"
  | "unrecognized_status"
  | "ledger_unavailable";

export type Flag = { code: FlagCode; tone: "info" | "warn" | "bad"; text: string };

export type ResultSummary = { code: string; tone: "ok" | "info" | "warn" | "bad"; text: string };

export type Evidence = {
  /**
   * Age of the newest observation of any kind on this server's clock: from the
   * earlier of when the harness says it observed and when this server received
   * it. Null if none.
   */
  ageMs: number | null;
  /** Age of the job data shown (schedule, state, result). Null if there is none. */
  jobAgeMs: number | null;
  /** True when what is shown is within the freshness limit: the job data if any, else the newest observation. */
  fresh: boolean;
  flags: Flag[];
  /** Whole-job result from the newest job observation, or null if there is none. */
  result: ResultSummary | null;
  job: Extract<Observation, { kind: "job" }> | null;
  refusal: Extract<Observation, { kind: "refused" }> | null;
};

const PULL_TEXT: Record<Exclude<PullOutcome, "ok">, string> = {
  unreachable: "could not reach the harness",
  timeout: "the harness did not answer in time",
  auth_refused: "the harness refused this key",
  host_key_mismatch: "the harness host key did not match",
  bad_output: "the harness sent something that is not a valid observation",
  output_too_large: "the harness sent too much data",
  not_configured: "this harness is not configured on this server",
};

const STATUS_RESULT: Record<string, ResultSummary> = {
  ok: { code: "ok", tone: "ok", text: "Job completed; delivery confirmed" },
  delivery_queued: { code: "delivery_queued", tone: "info", text: "Job completed; delivery not yet settled" },
  delivery_failed: { code: "delivery_failed", tone: "bad", text: "Job ran; its output did not reach its target" },
  error: { code: "error", tone: "bad", text: "Job failed" },
  blocked_config: { code: "blocked_config", tone: "bad", text: "Refused before running (configuration)" },
};

/** A value from a fixed table, or undefined. Never an inherited property such as `constructor`. */
export function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** One whole-job result line. Never coerces an unknown literal to success. */
export function describeResult(job: JobState, latest: ExecutionRecord | undefined): ResultSummary {
  if (latest && (latest.status === "running" || latest.status === "claimed")) {
    return { code: "running", tone: "info", text: "Running now" };
  }
  if (latest && latest.status === "unknown") {
    return { code: "unknown", tone: "warn", text: "Outcome unknown: the run lost its owner. Not counted as success" };
  }
  if (job.lastStatus === null) return { code: "never_run", tone: "info", text: "Never run" };
  return (
    lookup(STATUS_RESULT, job.lastStatus) ?? {
      code: "unrecognized",
      tone: "warn",
      text: `Unrecognized status "${job.lastStatus}". Not counted as success`,
    }
  );
}

function time(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Everything the panel shows about a link, derived from stored evidence.
 * `now` is this server's clock (the browser corrects for its own offset).
 */
export function describeEvidence(
  link: LinkView,
  latestJob: StoredObservation | null,
  latestAny: StoredObservation | null,
  now: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Evidence {
  const flags: Flag[] = [];
  const newest = latestAny ?? latestJob;
  // A harness clock ahead of ours must not make old data look new, so a later
  // observed_at is ignored. An earlier one is believed: the data may be old.
  const ageOf = (item: StoredObservation | null): number | null => {
    if (!item) return null;
    const observed = time(item.observation.observedAt);
    return Math.max(0, now - Math.min(item.receivedAt, observed ?? item.receivedAt));
  };
  const ageMs = ageOf(newest);
  const shownJob = latestJob && latestJob.observation.kind === "job" ? latestJob : null;
  const jobAgeMs = ageOf(shownJob);
  // Freshness belongs to what is on screen: the job data when there is any.
  const shownAge = shownJob ? jobAgeMs : ageMs;
  const fresh = shownAge !== null && shownAge <= thresholds.staleAfterMs;

  if (!newest) flags.push({ code: "never_observed", tone: "info", text: "Not observed yet. Use Refresh." });
  if (link.lastAttemptOutcome && link.lastAttemptOutcome !== "ok") {
    const shown = newest ? " Showing the last observation, not the current state." : "";
    flags.push({
      code: "disconnected",
      tone: "bad",
      text: `Disconnected: ${lookup<string>(PULL_TEXT, link.lastAttemptOutcome) ?? "the last check failed"}.${shown}`,
    });
  }
  if (newest && !fresh) {
    flags.push({
      code: "stale",
      tone: "warn",
      text: shownJob
        ? "Stale: the job details shown are older than the freshness limit."
        : "Stale: this observation is older than the freshness limit.",
    });
  }

  const refusal = newest?.observation.kind === "refused" ? newest.observation : null;
  if (refusal) {
    if (refusal.code === "not_found") {
      flags.push({ code: "not_found", tone: "bad", text: "Job not found on the harness. It may have been removed, or the ID or profile is wrong." });
    } else if (refusal.code === "unsupported_version" || refusal.code === "unsupported_schema") {
      flags.push({
        code: "unsupported",
        tone: "bad",
        text: `Unsupported harness version${refusal.harness.hermesVersion ? ` (Hermes ${refusal.harness.hermesVersion})` : ""}. Nothing was guessed.`,
      });
    } else {
      flags.push({ code: "refused", tone: "bad", text: `The harness refused the request (${refusal.code}).` });
    }
  }

  const job = latestJob && latestJob.observation.kind === "job" ? latestJob.observation : null;
  let result: ResultSummary | null = null;
  if (job && latestJob) {
    const observedAt = time(job.observedAt);
    if (observedAt !== null && observedAt - latestJob.receivedAt > CLOCK_SKEW_MS) {
      flags.push({ code: "clock_skew", tone: "warn", text: "Clock skew: the harness clock is ahead of this server. Ages use this server's clock." });
    }
    if (observedAt !== null && latestJob.receivedAt - observedAt > CLOCK_SKEW_MS) {
      flags.push({
        code: "observed_long_before_received",
        tone: "warn",
        text: "The harness says this was observed well before it arrived here. Either the data is old or the harness clock is behind; it is treated as old.",
      });
    }
    const beat = job.tickerHeartbeatAgeS;
    if (beat === null) {
      flags.push({ code: "scheduler_unknown", tone: "warn", text: "No scheduler heartbeat found. The next run may not happen." });
    } else if (beat > thresholds.heartbeatSilentS) {
      flags.push({ code: "scheduler_silent", tone: "bad", text: "Schedule shown, but the Hermes scheduler is not running. Jobs are probably not firing." });
    }
    const state = job.job.displayState;
    if (state === "paused") {
      flags.push({ code: "paused", tone: "info", text: `Paused${job.job.pausedAt ? ` since ${job.job.pausedAt}` : ""}.` });
    } else if (!job.job.runnable && state !== "completed") {
      flags.push({ code: "will_not_fire", tone: "warn", text: "Hermes shows this job as scheduled, but it is disabled or carries a pause marker, so it will not fire." });
    }
    const next = time(job.job.nextRunAt);
    if (state === "scheduled" && job.job.runnable && next !== null && observedAt !== null && next < observedAt - OVERDUE_MS) {
      flags.push({ code: "overdue", tone: "warn", text: "Overdue: the next run time had passed when this was observed." });
    }
    const latest = job.executions[0];
    result = describeResult(job.job, latest);
    if (result.code === "running" || state === "running") {
      flags.push({ code: "running", tone: "info", text: `Running now${latest?.startedAt ? ` (since ${latest.startedAt})` : ""}.` });
    }
    if (result.code === "unrecognized") {
      flags.push({ code: "unrecognized_status", tone: "warn", text: "The harness reported a status this version does not know." });
    }
    if (link.linkedFingerprint !== null && link.linkedFingerprint !== job.job.fingerprint.definitionSha256) {
      flags.push({ code: "definition_changed", tone: "warn", text: "This job's definition changed on the harness since it was linked." });
    }
    if (!job.executionsAvailable) {
      flags.push({ code: "ledger_unavailable", tone: "info", text: "The harness has no execution history for this profile." });
    }
  }

  return { ageMs, jobAgeMs, fresh, flags, result, job, refusal };
}
