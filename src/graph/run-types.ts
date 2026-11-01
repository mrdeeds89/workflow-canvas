import type { Preflight } from "./preflight.ts";

/** Run request shapes shared with the browser. No Node imports here. */

export type RunStatus =
  | "requested"
  | "claimed"
  | "running"
  | "waiting-approval"
  | "completed"
  | "failed"
  | "stopped"
  | "cancelled"
  | "expired";

/** Outcome of one step, as reported by the conductor from Kanban. Outcome only. */
export type StepStatus = "created" | "running" | "completed" | "failed" | "blocked" | "timed-out" | "gave-up";

export type RunStepOutcome = {
  cardId: string;
  status: StepStatus;
  /** For a decision card: the branch the worker reported, from the card's fixed list. */
  branch?: string;
};

export type RunDeliveryOutcome = {
  cardId: string;
  status: "sent" | "failed" | "skipped";
};

/** A human approval or rejection recorded against a run. Agents cannot write these. */
export type RunApproval = {
  cardId: string;
  decision: "approved" | "rejected";
  decidedAt: number;
};

/** What a conductor is allowed to report back. Outcome only; no free text leaves the harness. */
export type RunReportPayload = {
  runStatus?: Exclude<RunStatus, "requested" | "claimed" | "cancelled" | "expired">;
  steps?: RunStepOutcome[];
  deliveries?: RunDeliveryOutcome[];
};

export type RunView = {
  id: string;
  workflowId: string;
  revision: number;
  /** SHA-256 of the frozen definition, as stored. */
  digest: string;
  status: RunStatus;
  requestedAt: number;
  expiresAt: number;
  claimedAt: number | null;
  cancelledAt: number | null;
  stageCount: number;
  stepCount: number;
};

export type RunDetail = RunView & {
  plan: Preflight;
  approvals: RunApproval[];
  /** The most recent reported outcomes, or null before the first report. */
  outcomes: { steps: RunStepOutcome[]; deliveries: RunDeliveryOutcome[] } | null;
};
