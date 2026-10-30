import type { Library, ProjectSummary } from "../../src/graph/library.ts";
import type { ValidationIssue, WorkflowDefinition } from "../../src/graph/types.ts";
import type { LinkView, StoredObservation, Thresholds } from "../../src/harness/observation.ts";

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
