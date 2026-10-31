import type { Preflight } from "./preflight.ts";

/** Run request shapes shared with the browser. No Node imports here. */

export type RunStatus = "requested" | "expired" | "cancelled";

export type RunView = {
  id: string;
  workflowId: string;
  revision: number;
  /** SHA-256 of the frozen definition, as stored. */
  digest: string;
  status: RunStatus;
  requestedAt: number;
  expiresAt: number;
  cancelledAt: number | null;
  stageCount: number;
  stepCount: number;
};

export type RunDetail = RunView & { plan: Preflight };
