import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { compileRunBundle, type RunBundle } from "./bundle.ts";
import type { Preflight } from "./preflight.ts";
import type { WorkflowDefinition } from "./types.ts";
import type { RunApproval, RunDetail, RunReportPayload, RunStatus, RunStepOutcome, RunView } from "./run-types.ts";

/**
 * Run requests and their evidence, kept beside workflow documents.
 *
 * A request records that a person asked for a run of one frozen revision. It
 * starts nothing. A conductor on the Hermes machine claims a request, creates
 * Kanban tasks for it, and reports outcomes back here (docs/R2-PLAN.md).
 *
 * An unclaimed request expires after REQUEST_TTL_MS, so a conductor installed
 * later can never act on an old click. Once claimed it no longer expires: a
 * real run is under way and its evidence is kept. Approvals and reports are
 * append-only and are never touched by the request pruner (review finding 4).
 */

export const REQUEST_TTL_MS = 15 * 60 * 1000;
const KEEP_PER_WORKFLOW = 20;

export type { RunApproval, RunDetail, RunReportPayload, RunStatus, RunStepOutcome, RunView } from "./run-types.ts";

/** A run a conductor may act on now: an unclaimed, unexpired request and its bundle. */
export type PendingRun = { runId: string; workflowId: string; revision: number; bundle: RunBundle };

export type RunStore = {
  /** Record a request for a definition that passed preflight. */
  request(definition: WorkflowDefinition, plan: Preflight, now: number): RunDetail;
  /** The open (unclaimed, unexpired) request for a workflow, if any. */
  active(workflowId: string, now: number): RunView | null;
  list(workflowId: string, now: number): RunView[];
  get(workflowId: string, runId: string, now: number): RunDetail | null;
  /** Look a run up by its id alone (the conductor does not know the workflow id). */
  find(runId: string, now: number): RunDetail | null;
  /** The frozen document a run was requested for. */
  snapshot(workflowId: string, runId: string): WorkflowDefinition | null;
  cancel(workflowId: string, runId: string, now: number): RunView | null;
  removeWorkflow(workflowId: string): void;

  // --- Conductor-facing ---
  /** Every request a conductor may act on now, each with its compiled bundle. */
  pending(now: number): PendingRun[];
  /** Claim a request exactly once. Returns true for the caller that won. */
  claim(runId: string, now: number): boolean;
  /** Append an outcome report. Returns false if the payload is malformed. */
  report(runId: string, payload: unknown, now: number): boolean;

  // --- Human approvals (agents cannot write these) ---
  approve(workflowId: string, runId: string, cardId: string, decision: "approved" | "rejected", now: number): RunApproval | null;
  approvals(runId: string): RunApproval[];
  /** True if the workflow has a requested/claimed/running/waiting run. */
  hasActiveRun(workflowId: string, now: number): boolean;
};

type RunRow = {
  id: string;
  workflow_id: string;
  revision: number;
  digest: string;
  requested_at: number;
  expires_at: number;
  claimed_at: number | null;
  cancelled_at: number | null;
  state: string | null;
  plan: string;
  snapshot: string;
};

export function digestOf(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

const REPORT_RUN_STATES: ReadonlySet<string> = new Set(["running", "waiting-approval", "completed", "failed", "stopped"]);
const STEP_STATES: ReadonlySet<string> = new Set(["created", "running", "completed", "failed", "blocked", "timed-out", "gave-up"]);
const DELIVERY_STATES: ReadonlySet<string> = new Set(["sent", "failed", "skipped"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a conductor report, rejecting anything that is not outcome-only and well formed. */
function parseReport(value: unknown): RunReportPayload | null {
  if (!isRecord(value)) return null;
  const out: RunReportPayload = {};
  if (value.runStatus !== undefined) {
    if (typeof value.runStatus !== "string" || !REPORT_RUN_STATES.has(value.runStatus)) return null;
    out.runStatus = value.runStatus as RunReportPayload["runStatus"];
  }
  const okId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps) || value.steps.length > 500) return null;
    const steps: RunStepOutcome[] = [];
    for (const step of value.steps) {
      if (!isRecord(step) || !okId(step.cardId) || typeof step.status !== "string" || !STEP_STATES.has(step.status)) return null;
      if (step.branch !== undefined && (typeof step.branch !== "string" || step.branch.length > 100)) return null;
      steps.push({ cardId: step.cardId, status: step.status as RunStepOutcome["status"], ...(step.branch !== undefined ? { branch: step.branch } : {}) });
    }
    out.steps = steps;
  }
  if (value.deliveries !== undefined) {
    if (!Array.isArray(value.deliveries) || value.deliveries.length > 500) return null;
    const deliveries = [];
    for (const d of value.deliveries) {
      if (!isRecord(d) || !okId(d.cardId) || typeof d.status !== "string" || !DELIVERY_STATES.has(d.status)) return null;
      deliveries.push({ cardId: d.cardId, status: d.status as "sent" | "failed" | "skipped" });
    }
    out.deliveries = deliveries;
  }
  if (out.runStatus === undefined && out.steps === undefined && out.deliveries === undefined) return null;
  return out;
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
    CREATE TABLE IF NOT EXISTS run_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      decided_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_approvals_by_run ON run_approvals (run_id, decided_at);
    CREATE TABLE IF NOT EXISTS run_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_reports_by_run ON run_reports (run_id, received_at);
  `);
  // Columns added after the first release.
  const columns = new Set((db.prepare("PRAGMA table_info(run_requests)").all() as { name: string }[]).map((c) => c.name));
  if (!columns.has("claimed_at")) db.exec("ALTER TABLE run_requests ADD COLUMN claimed_at INTEGER");
  if (!columns.has("state")) db.exec("ALTER TABLE run_requests ADD COLUMN state TEXT");

  const insert = db.prepare(
    "INSERT INTO run_requests (id, workflow_id, revision, digest, requested_at, expires_at, claimed_at, cancelled_at, state, plan, snapshot) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
  );
  const byWorkflow = db.prepare("SELECT * FROM run_requests WHERE workflow_id = ? ORDER BY requested_at DESC, rowid DESC");
  const one = db.prepare("SELECT * FROM run_requests WHERE workflow_id = ? AND id = ?");
  const byId = db.prepare("SELECT * FROM run_requests WHERE id = ?");
  const cancelStmt = db.prepare(
    "UPDATE run_requests SET cancelled_at = ? WHERE workflow_id = ? AND id = ? AND cancelled_at IS NULL",
  );
  const claimStmt = db.prepare(
    "UPDATE run_requests SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL AND cancelled_at IS NULL AND expires_at > ?",
  );
  const setState = db.prepare("UPDATE run_requests SET state = ? WHERE id = ?");
  const pendingStmt = db.prepare(
    "SELECT * FROM run_requests WHERE claimed_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY requested_at",
  );
  // Prune only stale unclaimed clicks; never a claimed run or its evidence.
  const prune = db.prepare(
    "DELETE FROM run_requests WHERE workflow_id = ? AND claimed_at IS NULL AND cancelled_at IS NULL AND id NOT IN (SELECT id FROM run_requests WHERE workflow_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT ?)",
  );
  const removeUnclaimedReqs = db.prepare("DELETE FROM run_requests WHERE workflow_id = ? AND claimed_at IS NULL");
  const insertApproval = db.prepare(
    "INSERT INTO run_approvals (workflow_id, run_id, card_id, decision, decided_at) VALUES (?, ?, ?, ?, ?)",
  );
  const approvalsByRun = db.prepare("SELECT card_id, decision, decided_at FROM run_approvals WHERE run_id = ? ORDER BY decided_at");
  const insertReport = db.prepare("INSERT INTO run_reports (workflow_id, run_id, received_at, payload) VALUES (?, ?, ?, ?)");
  const latestReport = db.prepare("SELECT payload FROM run_reports WHERE run_id = ? ORDER BY received_at DESC, id DESC LIMIT 1");

  function statusOf(row: RunRow, now: number): RunStatus {
    if (row.cancelled_at !== null) return "cancelled";
    if (row.state !== null && REPORT_RUN_STATES.has(row.state)) return row.state as RunStatus;
    if (row.claimed_at !== null) return "claimed";
    if (now >= row.expires_at) return "expired";
    return "requested";
  }

  function parsePlan(row: RunRow): Preflight {
    try {
      return JSON.parse(row.plan) as Preflight;
    } catch {
      return { ok: false, issues: [], notices: ["The stored plan could not be read."], stages: [], deliveries: [] };
    }
  }

  function view(row: RunRow, now: number): RunView {
    const plan = parsePlan(row);
    return {
      id: row.id,
      workflowId: row.workflow_id,
      revision: row.revision,
      digest: row.digest,
      status: statusOf(row, now),
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      claimedAt: row.claimed_at,
      cancelledAt: row.cancelled_at,
      stageCount: plan.stages.length,
      stepCount: plan.stages.reduce((total, stage) => total + stage.steps.length, 0),
    };
  }

  function approvalsOf(runId: string): RunApproval[] {
    // Keep the latest decision per card, in decision order.
    const byCard = new Map<string, RunApproval>();
    for (const row of approvalsByRun.all(runId) as { card_id: string; decision: string; decided_at: number }[]) {
      byCard.set(row.card_id, { cardId: row.card_id, decision: row.decision as "approved" | "rejected", decidedAt: row.decided_at });
    }
    return [...byCard.values()];
  }

  function outcomesOf(runId: string): RunDetail["outcomes"] {
    const row = latestReport.get(runId) as { payload: string } | undefined;
    if (!row) return null;
    const parsed = parseReport(JSON.parse(row.payload));
    if (!parsed) return null;
    return { steps: parsed.steps ?? [], deliveries: parsed.deliveries ?? [] };
  }

  function detail(row: RunRow, now: number): RunDetail {
    return { ...view(row, now), plan: parsePlan(row), approvals: approvalsOf(row.id), outcomes: outcomesOf(row.id) };
  }

  return {
    request(definition, plan, now) {
      const snapshot = JSON.stringify(definition);
      const id = randomUUID();
      insert.run(id, definition.id, definition.revision, digestOf(snapshot), now, now + REQUEST_TTL_MS, JSON.stringify(plan), snapshot);
      prune.run(definition.id, definition.id, KEEP_PER_WORKFLOW);
      return detail(one.get(definition.id, id) as RunRow, now);
    },
    active(workflowId, now) {
      const rows = byWorkflow.all(workflowId) as RunRow[];
      return rows.map((row) => view(row, now)).find((run) => run.status === "requested") ?? null;
    },
    list(workflowId, now) {
      return (byWorkflow.all(workflowId) as RunRow[]).map((row) => view(row, now));
    },
    get(workflowId, runId, now) {
      const row = one.get(workflowId, runId) as RunRow | undefined;
      return row ? detail(row, now) : null;
    },
    find(runId, now) {
      const row = byId.get(runId) as RunRow | undefined;
      return row ? detail(row, now) : null;
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
      cancelStmt.run(now, workflowId, runId);
      const row = one.get(workflowId, runId) as RunRow | undefined;
      return row ? view(row, now) : null;
    },
    removeWorkflow(workflowId) {
      // Keep run evidence durable (approvals, reports, and any claimed run) as a
      // tombstone; only stale, never-claimed requests are cleared.
      removeUnclaimedReqs.run(workflowId);
    },
    pending(now) {
      const out: PendingRun[] = [];
      for (const row of pendingStmt.all(now) as RunRow[]) {
        const plan = parsePlan(row);
        if (!plan.ok) continue;
        let definition: WorkflowDefinition;
        try {
          definition = JSON.parse(row.snapshot) as WorkflowDefinition;
        } catch {
          continue;
        }
        out.push({ runId: row.id, workflowId: row.workflow_id, revision: row.revision, bundle: compileRunBundle(definition, plan, row.id, row.digest) });
      }
      return out;
    },
    claim(runId, now) {
      const result = claimStmt.run(now, runId, now);
      return Number(result.changes) > 0;
    },
    report(runId, payload, now) {
      const row = byId.get(runId) as RunRow | undefined;
      if (!row) return false;
      // Only a run the conductor has actually claimed, and not cancelled, may be reported on.
      if (row.claimed_at === null || row.cancelled_at !== null) return false;
      const parsed = parseReport(payload);
      if (!parsed) return false;
      insertReport.run(row.workflow_id, runId, now, JSON.stringify(parsed));
      if (parsed.runStatus !== undefined) setState.run(parsed.runStatus, runId);
      return true;
    },
    approve(workflowId, runId, cardId, decision, now) {
      const row = one.get(workflowId, runId) as RunRow | undefined;
      if (!row) return null;
      // A finished run cannot be approved, and only an approval card in this run's plan can be.
      if (["completed", "failed", "stopped", "cancelled", "expired"].includes(statusOf(row, now))) return null;
      const plan = parsePlan(row);
      const isApprovalCard = plan.stages.some((stage) => stage.steps.some((step) => step.cardId === cardId && step.role === "approval"));
      if (!isApprovalCard) return null;
      insertApproval.run(workflowId, runId, cardId, decision, now);
      return { cardId, decision, decidedAt: now };
    },
    hasActiveRun(workflowId, now) {
      const open = new Set(["requested", "claimed", "running", "waiting-approval"]);
      return (byWorkflow.all(workflowId) as RunRow[]).some((row) => open.has(statusOf(row, now)));
    },
    approvals(runId) {
      return approvalsOf(runId);
    },
  };
}
