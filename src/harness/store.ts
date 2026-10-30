import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseObservation, type LinkView, type Observation, type PullOutcome, type StoredObservation } from "./observation.ts";

/**
 * Links between workflows and Hermes jobs, and the observations pulled for them.
 *
 * Kept beside the workflow table, never inside the workflow document: linking,
 * refreshing, and unlinking never change a workflow's revision, and a workflow
 * export never carries a harness job id. Observations are evidence copied from
 * the harness, stored as validated (allowlisted) JSON with a hash of the raw text.
 */

export const KEEP_OBSERVATIONS = 20;

export type HarnessStore = {
  link(workflowId: string): LinkView | null;
  setLink(workflowId: string, harness: string, profile: string, jobId: string, now: number): LinkView;
  unlink(workflowId: string): boolean;
  /**
   * Store a pull outcome and, when one arrived, the observation. Ignored when the
   * link no longer names `expected`, so a late pull cannot land on a newer link.
   */
  recordPull(
    workflowId: string,
    expected: Pick<LinkView, "harness" | "profile" | "jobId">,
    outcome: PullOutcome,
    now: number,
    observation?: { value: Observation; raw: string; source: string },
  ): void;
  /** Newest job observation and newest observation of any kind, for the current link. */
  latest(workflowId: string): { job: StoredObservation | null; any: StoredObservation | null };
};

type LinkRow = {
  harness: string;
  profile: string;
  job_id: string;
  linked_at: number;
  linked_fingerprint: string | null;
  last_attempt_at: number | null;
  last_attempt_outcome: string | null;
};

type ObservationRow = { payload: string; received_at: number; source: string };

export function initHarnessTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS harness_links (
      workflow_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      profile TEXT NOT NULL,
      job_id TEXT NOT NULL,
      linked_at INTEGER NOT NULL,
      linked_fingerprint TEXT,
      last_attempt_at INTEGER,
      last_attempt_outcome TEXT
    );
    CREATE TABLE IF NOT EXISTS harness_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      harness TEXT NOT NULL,
      profile TEXT NOT NULL,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_harness_observations_link
      ON harness_observations (workflow_id, harness, profile, job_id, received_at DESC, id DESC);
  `);
}

function toView(row: LinkRow): LinkView {
  return {
    harness: row.harness,
    profile: row.profile,
    jobId: row.job_id,
    linkedAt: row.linked_at,
    linkedFingerprint: row.linked_fingerprint,
    lastAttemptAt: row.last_attempt_at,
    lastAttemptOutcome: (row.last_attempt_outcome as PullOutcome | null) ?? null,
  };
}

function toStored(row: ObservationRow | undefined): StoredObservation | null {
  if (!row) return null;
  // Stored payloads were validated on the way in. Re-validate so a hand-edited
  // or older row can never reach the page unchecked.
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload) as unknown;
  } catch {
    return null;
  }
  const parsed = parseObservation(raw);
  return parsed.ok ? { observation: parsed.value, receivedAt: row.received_at, source: row.source } : null;
}

/** Back to the exporter's wire shape, so a stored row re-parses exactly. */
function toWire(observation: Observation): unknown {
  const harness = {
    hermes_version: observation.harness.hermesVersion,
    exporter_version: observation.harness.exporterVersion,
    profile: observation.harness.profile,
  };
  const base = { format: "workflow-canvas.hermes-observation", version: 1, observed_at: observation.observedAt, harness };
  if (observation.kind === "refused") return { ...base, error: { code: observation.code } };
  const { job } = observation;
  return {
    ...base,
    scheduler: { ticker_heartbeat_age_s: observation.tickerHeartbeatAgeS },
    job: {
      job_id: job.jobId,
      name: job.name,
      schedule: { kind: job.schedule.kind, display: job.schedule.display },
      timezone: job.timezone,
      display_state: job.displayState,
      enabled: job.enabled,
      runnable: job.runnable,
      paused_at: job.pausedAt,
      next_run_at: job.nextRunAt,
      last_run_at: job.lastRunAt,
      last_status: job.lastStatus,
      has_error_detail: job.hasErrorDetail,
      delivery_kinds: job.deliveryKinds,
      fingerprint: {
        definition_sha256: job.fingerprint.definitionSha256,
        skills: job.fingerprint.skills,
        script_present: job.fingerprint.scriptPresent,
        no_agent: job.fingerprint.noAgent,
        model_pinned: job.fingerprint.modelPinned,
      },
    },
    executions_available: observation.executionsAvailable,
    executions: observation.executions.map((run) => ({
      id: run.id,
      status: run.status,
      source: run.source,
      scheduled_instant: run.scheduledInstant,
      claimed_at: run.claimedAt,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      progress_at: run.progressAt,
      delivery_outcome: run.deliveryOutcome,
    })),
  };
}

export function createHarnessStore(db: DatabaseSync): HarnessStore {
  initHarnessTables(db);
  const selectLink = db.prepare(
    "SELECT harness, profile, job_id, linked_at, linked_fingerprint, last_attempt_at, last_attempt_outcome FROM harness_links WHERE workflow_id = ?",
  );
  const upsertLink = db.prepare(`
    INSERT INTO harness_links (workflow_id, harness, profile, job_id, linked_at, linked_fingerprint, last_attempt_at, last_attempt_outcome)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
    ON CONFLICT (workflow_id) DO UPDATE SET
      harness = excluded.harness, profile = excluded.profile, job_id = excluded.job_id,
      linked_at = excluded.linked_at, linked_fingerprint = NULL, last_attempt_at = NULL, last_attempt_outcome = NULL
  `);
  const deleteLink = db.prepare("DELETE FROM harness_links WHERE workflow_id = ?");
  const deleteObservations = db.prepare("DELETE FROM harness_observations WHERE workflow_id = ?");
  const markAttempt = db.prepare(
    "UPDATE harness_links SET last_attempt_at = ?, last_attempt_outcome = ? WHERE workflow_id = ?",
  );
  const setFingerprint = db.prepare(
    "UPDATE harness_links SET linked_fingerprint = ? WHERE workflow_id = ? AND linked_fingerprint IS NULL",
  );
  const insertObservation = db.prepare(`
    INSERT INTO harness_observations (workflow_id, harness, profile, job_id, kind, observed_at, received_at, source, payload_sha256, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const latestOf = (kindClause: string) =>
    db.prepare(`
      SELECT payload, received_at, source FROM harness_observations
      WHERE workflow_id = ? AND harness = ? AND profile = ? AND job_id = ? ${kindClause}
      ORDER BY received_at DESC, id DESC LIMIT 1
    `);
  const latestJob = latestOf("AND kind = 'job'");
  const latestAny = latestOf("");
  const prune = db.prepare(`
    DELETE FROM harness_observations WHERE workflow_id = ? AND id NOT IN (
      SELECT id FROM harness_observations WHERE workflow_id = ? ORDER BY received_at DESC, id DESC LIMIT ?
    )
  `);

  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    link(workflowId) {
      const row = selectLink.get(workflowId) as LinkRow | undefined;
      return row ? toView(row) : null;
    },

    setLink(workflowId, harness, profile, jobId, now) {
      return transaction(() => {
        const previous = selectLink.get(workflowId) as LinkRow | undefined;
        const same = previous && previous.harness === harness && previous.profile === profile && previous.job_id === jobId;
        if (same) return toView(previous);
        // A different job: evidence about the old one must not show under the new link.
        deleteObservations.run(workflowId);
        upsertLink.run(workflowId, harness, profile, jobId, now);
        return toView(selectLink.get(workflowId) as LinkRow);
      });
    },

    unlink(workflowId) {
      return transaction(() => {
        deleteObservations.run(workflowId);
        return deleteLink.run(workflowId).changes === 1;
      });
    },

    recordPull(workflowId, expected, outcome, now, observation) {
      transaction(() => {
        const row = selectLink.get(workflowId) as LinkRow | undefined;
        if (!row) return;
        if (row.harness !== expected.harness || row.profile !== expected.profile || row.job_id !== expected.jobId) return;
        markAttempt.run(now, outcome, workflowId);
        if (!observation) return;
        const value = observation.value;
        const payload = JSON.stringify(toWire(value));
        insertObservation.run(
          workflowId, row.harness, row.profile, row.job_id, value.kind, value.observedAt, now, observation.source,
          createHash("sha256").update(observation.raw).digest("hex"), payload,
        );
        if (value.kind === "job") setFingerprint.run(value.job.fingerprint.definitionSha256, workflowId);
        prune.run(workflowId, workflowId, KEEP_OBSERVATIONS);
      });
    },

    latest(workflowId) {
      const row = selectLink.get(workflowId) as LinkRow | undefined;
      if (!row) return { job: null, any: null };
      const keys = [workflowId, row.harness, row.profile, row.job_id] as const;
      return {
        job: toStored(latestJob.get(...keys) as ObservationRow | undefined),
        any: toStored(latestAny.get(...keys) as ObservationRow | undefined),
      };
    },
  };
}
