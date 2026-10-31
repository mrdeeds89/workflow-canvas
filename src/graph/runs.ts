import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { Preflight } from "./preflight.ts";
import type { WorkflowDefinition } from "./types.ts";
import type { RunDetail, RunView } from "./run-types.ts";

/**
 * Run requests, kept beside workflow documents.
 *
 * A request is a record that a person asked for a run of one frozen revision.
 * It does not start anything. No conductor reads these yet (docs/RUN-PLAN.md,
 * slice R1). A request expires after REQUEST_TTL_MS so a conductor installed
 * later can never pick up an old click.
 */

export const REQUEST_TTL_MS = 15 * 60 * 1000;
const KEEP_PER_WORKFLOW = 20;

export type { RunDetail, RunStatus, RunView } from "./run-types.ts";

export type RunStore = {
  /** Record a request for a definition that passed preflight. */
  request(definition: WorkflowDefinition, plan: Preflight, now: number): RunDetail;
  /** The open request for a workflow, if one has not expired or been cancelled. */
  active(workflowId: string, now: number): RunView | null;
  list(workflowId: string, now: number): RunView[];
  get(workflowId: string, runId: string, now: number): RunDetail | null;
  /** The frozen document a run was requested for. */
  snapshot(workflowId: string, runId: string): WorkflowDefinition | null;
  cancel(workflowId: string, runId: string, now: number): RunView | null;
  removeWorkflow(workflowId: string): void;
};

type RunRow = {
  id: string;
  workflow_id: string;
  revision: number;
  digest: string;
  requested_at: number;
  expires_at: number;
  cancelled_at: number | null;
  plan: string;
  snapshot: string;
};

export function digestOf(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export function createRunStore(db: DatabaseSync): RunStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_requests (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      digest TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      cancelled_at INTEGER,
      plan TEXT NOT NULL,
      snapshot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_requests_by_workflow ON run_requests (workflow_id, requested_at);
  `);
  const insert = db.prepare(
    "INSERT INTO run_requests (id, workflow_id, revision, digest, requested_at, expires_at, cancelled_at, plan, snapshot) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
  );
  const byWorkflow = db.prepare(
    "SELECT * FROM run_requests WHERE workflow_id = ? ORDER BY requested_at DESC, rowid DESC",
  );
  const one = db.prepare("SELECT * FROM run_requests WHERE workflow_id = ? AND id = ?");
  const cancelStmt = db.prepare(
    "UPDATE run_requests SET cancelled_at = ? WHERE workflow_id = ? AND id = ? AND cancelled_at IS NULL AND expires_at > ?",
  );
  const prune = db.prepare(
    "DELETE FROM run_requests WHERE workflow_id = ? AND id NOT IN (SELECT id FROM run_requests WHERE workflow_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT ?)",
  );
  const removeAll = db.prepare("DELETE FROM run_requests WHERE workflow_id = ?");

  function view(row: RunRow, now: number): RunView {
    let plan: Preflight | null = null;
    try {
      plan = JSON.parse(row.plan) as Preflight;
    } catch {
      plan = null;
    }
    return {
      id: row.id,
      workflowId: row.workflow_id,
      revision: row.revision,
      digest: row.digest,
      status: row.cancelled_at !== null ? "cancelled" : now >= row.expires_at ? "expired" : "requested",
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      cancelledAt: row.cancelled_at,
      stageCount: plan?.stages.length ?? 0,
      stepCount: plan?.stages.reduce((total, stage) => total + stage.steps.length, 0) ?? 0,
    };
  }

  return {
    request(definition, plan, now) {
      const snapshot = JSON.stringify(definition);
      const id = randomUUID();
      insert.run(id, definition.id, definition.revision, digestOf(snapshot), now, now + REQUEST_TTL_MS, JSON.stringify(plan), snapshot);
      prune.run(definition.id, definition.id, KEEP_PER_WORKFLOW);
      const row = one.get(definition.id, id) as RunRow;
      return { ...view(row, now), plan };
    },
    active(workflowId, now) {
      const rows = byWorkflow.all(workflowId) as RunRow[];
      const open = rows.map((row) => view(row, now)).find((run) => run.status === "requested");
      return open ?? null;
    },
    list(workflowId, now) {
      return (byWorkflow.all(workflowId) as RunRow[]).map((row) => view(row, now));
    },
    get(workflowId, runId, now) {
      const row = one.get(workflowId, runId) as RunRow | undefined;
      if (!row) return null;
      let plan: Preflight;
      try {
        plan = JSON.parse(row.plan) as Preflight;
      } catch {
        plan = { ok: false, issues: [], notices: ["The stored plan could not be read."], stages: [] };
      }
      return { ...view(row, now), plan };
    },
    snapshot(workflowId, runId) {
      const row = one.get(workflowId, runId) as RunRow | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.snapshot) as WorkflowDefinition;
      } catch {
        return null;
      }
    },
    cancel(workflowId, runId, now) {
      cancelStmt.run(now, workflowId, runId, now);
      const row = one.get(workflowId, runId) as RunRow | undefined;
      return row ? view(row, now) : null;
    },
    removeWorkflow(workflowId) {
      removeAll.run(workflowId);
    },
  };
}
