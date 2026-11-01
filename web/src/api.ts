import type { Library, ProjectSummary } from "../../src/graph/library.ts";
import type { DeliveryTarget, ValidationIssue, WorkflowDefinition } from "../../src/graph/types.ts";
import type { LinkView, StoredObservation, Thresholds } from "../../src/harness/observation.ts";
import type { RunApproval, RunDetail, RunView } from "../../src/graph/run-types.ts";

export type { DeliveryTarget } from "../../src/graph/types.ts";

export type { Library, ProjectSummary, WorkflowSummary } from "../../src/graph/library.ts";

/** A failed API call, carrying the server's error code and any validation issues. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ValidationIssue[];

  constructor(status: number, code: string, message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

type ErrorPayload = { error?: { code?: string; message?: string; issues?: ValidationIssue[] } };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error = (payload as ErrorPayload | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "http_error",
      error?.message ?? `Request failed with status ${response.status}.`,
      error?.issues ?? [],
    );
  }
  return payload as T;
}

export function createWorkflow(title: string, projectId: string | null = null): Promise<WorkflowDefinition> {
  return request("POST", "/api/workflows", { title, projectId });
}

export function fetchLibrary(): Promise<Library> {
  return request("GET", "/api/library");
}

export function createProject(title: string): Promise<ProjectSummary> {
  return request("POST", "/api/projects", { title });
}

export function renameProject(id: string, title: string): Promise<ProjectSummary> {
  return request("PATCH", `/api/projects/${encodeURIComponent(id)}`, { title });
}

/** Put a workflow in a project (null = Unfiled) at `index`; returns the new library. */
export function moveWorkflow(id: string, projectId: string | null, index: number): Promise<Library> {
  return request("POST", `/api/workflows/${encodeURIComponent(id)}/move`, { projectId, index });
}

export function duplicateWorkflow(id: string): Promise<WorkflowDefinition> {
  return request("POST", `/api/workflows/${encodeURIComponent(id)}/duplicate`);
}

export async function deleteWorkflow(id: string): Promise<void> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new ApiError(response.status, "http_error", `Delete failed with status ${response.status}.`);
  }
}

export function loadWorkflow(id: string): Promise<WorkflowDefinition> {
  return request("GET", `/api/workflows/${encodeURIComponent(id)}`);
}

/** Saves the document; its `revision` is the one the client expects to replace. */
export function saveWorkflow(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
  return request("PUT", `/api/workflows/${encodeURIComponent(definition.id)}`, definition);
}

// --- Run requests (records only; nothing runs) ----------------------------------

export type RunsListing = { runs: RunView[]; conductor: "none" | "connected"; targets: DeliveryTarget[]; requestTtlMs: number; serverNow: number };

export function fetchRuns(workflowId: string): Promise<RunsListing> {
  return request("GET", `/api/workflows/${encodeURIComponent(workflowId)}/runs`);
}

/** Record a run request for the revision the browser checked. Nothing starts. */
export function requestRun(workflowId: string, expectedRevision: number): Promise<RunDetail> {
  return request("POST", `/api/workflows/${encodeURIComponent(workflowId)}/runs`, { expectedRevision });
}

export function cancelRun(workflowId: string, runId: string): Promise<RunView> {
  return request("POST", `/api/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/cancel`);
}

export function fetchRun(workflowId: string, runId: string): Promise<RunDetail> {
  return request("GET", `/api/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}`);
}

/** Record a human decision on an Approval card. Agents cannot write these. */
export function approveRun(workflowId: string, runId: string, cardId: string, decision: "approved" | "rejected"): Promise<RunApproval> {
  return request("POST", `/api/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/approvals`, { cardId, decision });
}

// --- Connecting a Hermes (pairing + delivery targets) --------------------------

export type ConnectionView = { connected: boolean; createdAt: number | null; targets: DeliveryTarget[] };

/** Begin pairing: returns a one-time code to type on the Hermes machine. */
export function startPairing(): Promise<{ code: string; expiresAt: number }> {
  return request("POST", "/api/connect");
}

export function fetchConnection(): Promise<ConnectionView> {
  return request("GET", "/api/connection");
}

export async function disconnect(): Promise<void> {
  const response = await fetch("/api/connection", { method: "DELETE" });
  if (!response.ok) throw new ApiError(response.status, "http_error", `Disconnect failed with status ${response.status}.`);
}

export function fetchDeliveryTargets(): Promise<DeliveryTarget[]> {
  return request<{ targets: DeliveryTarget[] }>("GET", "/api/delivery-targets").then((payload) => payload.targets);
}

// --- Hermes job evidence (read-only) -------------------------------------------

export type HarnessSummary = { label: string; profiles: string[]; exampleJobs: string[] };

export type JobEvidenceView = {
  link: LinkView | null;
  latestJob: StoredObservation | null;
  latestAny: StoredObservation | null;
  configured: boolean | null;
  thresholds: Thresholds;
  serverNow: number;
};

export async function fetchHarnesses(): Promise<HarnessSummary[]> {
  return (await request<{ harnesses: HarnessSummary[] }>("GET", "/api/harnesses")).harnesses;
}

export function fetchJobEvidence(workflowId: string): Promise<JobEvidenceView> {
  return request("GET", `/api/workflows/${encodeURIComponent(workflowId)}/harness`);
}

export function linkJob(workflowId: string, harness: string, profile: string, jobId: string): Promise<JobEvidenceView> {
  return request("PUT", `/api/workflows/${encodeURIComponent(workflowId)}/harness-link`, { harness, profile, jobId });
}

export async function unlinkJob(workflowId: string): Promise<void> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/harness-link`, { method: "DELETE" });
  if (!response.ok) throw new ApiError(response.status, "http_error", `Unlink failed with status ${response.status}.`);
}

/** Ask the server to pull a fresh observation. It never runs, pauses, or resumes the job. */
export function refreshJob(workflowId: string): Promise<JobEvidenceView> {
  return request("POST", `/api/workflows/${encodeURIComponent(workflowId)}/harness-link/refresh`);
}
