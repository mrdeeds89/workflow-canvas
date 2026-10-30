import type { ValidationIssue, WorkflowDefinition } from "../../src/graph/types.ts";

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

export function createWorkflow(title: string): Promise<WorkflowDefinition> {
  return request("POST", "/api/workflows", { title });
}

export function loadWorkflow(id: string): Promise<WorkflowDefinition> {
  return request("GET", `/api/workflows/${encodeURIComponent(id)}`);
}

/** Saves the document; its `revision` is the one the client expects to replace. */
export function saveWorkflow(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
  return request("PUT", `/api/workflows/${encodeURIComponent(definition.id)}`, definition);
}
