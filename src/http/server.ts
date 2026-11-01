import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { MAX_PROJECT_TITLE, type WorkflowStore } from "../graph/store.ts";
import type { ValidationIssue, WorkflowDefinition } from "../graph/types.ts";
import { EMPTY_CONFIG, type HarnessConfig } from "../harness/config.ts";
import { JOB_ID_PATTERN, LABEL_PATTERN, parseObservation, type PullOutcome } from "../harness/observation.ts";
import { defaultSource, type ObservationSource } from "../harness/source.ts";
import { preflight } from "../graph/preflight.ts";
import { REQUEST_TTL_MS } from "../graph/runs.ts";

/**
 * Private design-time API over the workflow store.
 *
 * This service stores and returns workflow definitions. It never interprets
 * node instructions, edge labels, or any other imported text as a command,
 * and it exposes no execution route. A run request is a record a person
 * makes; nothing in this process acts on it (docs/RUN-PLAN.md).
 */

export const MAX_BODY_BYTES = 1_000_000;
const MAX_ID_LENGTH = 128;

export type AppOptions = {
  store: WorkflowStore;
  /** Browser origins allowed to call this API. Default deny for any other origin. */
  allowedOrigins?: string[];
  /** Built canvas UI to serve for non-API paths. Omit to serve the API only. */
  staticDir?: string;
  /** Hermes harnesses this server may observe. Default: none. */
  harnessConfig?: HarnessConfig;
  /** Where observations come from. Tests replace this; the default uses the config's transports. */
  observationSource?: ObservationSource;
  /** Clock, for tests. */
  now?: () => number;
};

type Harness = {
  config: HarnessConfig;
  source: ObservationSource;
  now: () => number;
  /** One pull per workflow at a time; a second Refresh joins the first. */
  inflight: Map<string, Promise<void>>;
  /**
   * Last pull per harness/profile/job, in memory. Re-linking, or several
   * workflows linked to one job, cannot pull that job faster than the limit.
   */
  lastPull: Map<string, number>;
};

/**
 * Policy for the canvas page. Scripts may only come from this server, so text
 * stored in a workflow can never run as script even if a rendering bug let it
 * reach the DOM as markup. Inline styles are allowed because the canvas
 * positions cards with them.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

type ErrorBody = {
  error: {
    code: string;
    message: string;
    issues?: ValidationIssue[];
  };
};

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  issues?: ValidationIssue[],
): void {
  const payload: ErrorBody = { error: { code, message } };
  if (issues) payload.error.issues = issues;
  sendJson(res, status, payload);
}

async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      status: 415,
      code: "unsupported_media_type",
      message: "Request body must be application/json.",
    };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      return {
        ok: false,
        status: 413,
        code: "payload_too_large",
        message: `Request body must be ${MAX_BODY_BYTES} bytes or fewer.`,
      };
    }
    chunks.push(buffer);
  }

  if (total === 0) {
    return { ok: false, status: 400, code: "empty_body", message: "Request body is required." };
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, status: 400, code: "malformed_json", message: "Request body is not valid JSON." };
  }
}

function originAllowed(req: IncomingMessage, allowedOrigins: string[]): boolean {
  const origin = req.headers.origin;
  // Non-browser and same-origin navigation requests send no Origin header.
  if (typeof origin !== "string" || origin === "") return true;
  return allowedOrigins.includes(origin);
}

export function createApp({
  store,
  allowedOrigins = [],
  staticDir,
  harnessConfig = EMPTY_CONFIG,
  observationSource,
  now = Date.now,
}: AppOptions): Server {
  const staticRoot = staticDir === undefined ? undefined : resolve(staticDir);
  const harness: Harness = {
    config: harnessConfig,
    source: observationSource ?? defaultSource(now),
    now,
    inflight: new Map(),
    lastPull: new Map(),
  };
  return createServer((req, res) => {
    void handle(req, res, store, allowedOrigins, staticRoot, harness).catch(() => {
      if (!res.headersSent) {
        sendError(res, 500, "internal_error", "The request could not be completed.");
      } else {
        res.end();
      }
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  allowedOrigins: string[],
  staticRoot: string | undefined,
  harness: Harness,
): Promise<void> {
  const method = req.method ?? "GET";
  let path: string;
  try {
    path = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    sendError(res, 400, "bad_request", "The request target is not a valid URL.");
    return;
  }

  // Everything outside /api is the canvas page and its assets.
  if (path !== "/api" && !path.startsWith("/api/")) {
    if (staticRoot === undefined) {
      sendError(res, 404, "not_found", "No such route.");
      return;
    }
    await serveStatic(req, res, staticRoot, path);
    return;
  }

  if (!originAllowed(req, allowedOrigins)) {
    sendError(res, 403, "forbidden_origin", "This origin may not call the API.");
    return;
  }

  if (path === "/api/health") {
    if (method !== "GET") return methodNotAllowed(res, ["GET"]);
    sendJson(res, 200, { status: "ok", execution: "disabled" });
    return;
  }

  if (path === "/api/workflows") {
    if (method !== "POST") return methodNotAllowed(res, ["POST"]);
    await createWorkflow(req, res, store);
    return;
  }

  if (path === "/api/library") {
    if (method !== "GET") return methodNotAllowed(res, ["GET"]);
    sendJson(res, 200, store.library());
    return;
  }

  if (path === "/api/projects") {
    if (method !== "POST") return methodNotAllowed(res, ["POST"]);
    await createProject(req, res, store);
    return;
  }

  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (projectMatch) {
    const id = pathId(projectMatch[1]!);
    if (id === null) return sendError(res, 400, "bad_request", "The project id is not valid.");
    if (method !== "PATCH") return methodNotAllowed(res, ["PATCH"]);
    await renameProject(req, res, store, id);
    return;
  }

  const actionMatch = /^\/api\/workflows\/([^/]+)\/(move|duplicate)$/.exec(path);
  if (actionMatch) {
    const id = pathId(actionMatch[1]!);
    if (id === null) return sendError(res, 400, "bad_request", "The workflow id is not valid.");
    if (method !== "POST") return methodNotAllowed(res, ["POST"]);
    if (actionMatch[2] === "move") {
      await moveWorkflow(req, res, store, id);
    } else {
      const copy = store.duplicateWorkflow(id);
      if (!copy) return sendError(res, 404, "not_found", "No such workflow.");
      res.setHeader("location", `/api/workflows/${encodeURIComponent(copy.id)}`);
      sendJson(res, 201, copy);
    }
    return;
  }

  if (path === "/api/harnesses") {
    if (method !== "GET") return methodNotAllowed(res, ["GET"]);
    // Labels only. Hosts, users and key paths never leave the server.
    sendJson(res, 200, { harnesses: harness.config.harnesses });
    return;
  }

  const harnessMatch = /^\/api\/workflows\/([^/]+)\/(harness|harness-link|harness-link\/refresh)$/.exec(path);
  if (harnessMatch) {
    const id = pathId(harnessMatch[1]!);
    if (id === null) return sendError(res, 400, "bad_request", "The workflow id is not valid.");
    if (store.load(id) === null) return sendError(res, 404, "not_found", "No such workflow.");
    const route = harnessMatch[2];
    if (route === "harness") {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]);
      return sendJson(res, 200, harnessView(store, harness, id));
    }
    if (route === "harness-link") {
      if (method === "PUT") return linkJob(req, res, store, harness, id);
      if (method === "DELETE") {
        store.harness.unlink(id);
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }
      return methodNotAllowed(res, ["PUT", "DELETE"]);
    }
    if (method !== "POST") return methodNotAllowed(res, ["POST"]);
    return refreshJob(res, store, harness, id);
  }

  const runsMatch = /^\/api\/workflows\/([^/]+)\/runs(?:\/([^/]+)(\/cancel|\/approvals)?)?$/.exec(path);
  if (runsMatch) {
    const id = pathId(runsMatch[1]!);
    if (id === null) return sendError(res, 400, "bad_request", "The workflow id is not valid.");
    if (store.load(id) === null) return sendError(res, 404, "not_found", "No such workflow.");
    if (runsMatch[2] === undefined) {
      if (method === "GET") return sendJson(res, 200, runsView(store, harness, id));
      if (method === "POST") return requestRun(req, res, store, harness, id);
      return methodNotAllowed(res, ["GET", "POST"]);
    }
    const runId = pathId(runsMatch[2]);
    if (runId === null) return sendError(res, 400, "bad_request", "The run id is not valid.");
    if (runsMatch[3] === undefined) {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]);
      const detail = store.runs.get(id, runId, harness.now());
      if (!detail) return sendError(res, 404, "not_found", "No such run request.");
      return sendJson(res, 200, detail);
    }
    if (runsMatch[3] === "/approvals") {
      if (method !== "POST") return methodNotAllowed(res, ["POST"]);
      return approveRun(req, res, store, harness, id, runId);
    }
    if (method !== "POST") return methodNotAllowed(res, ["POST"]);
    return cancelRun(res, store, harness, id, runId);
  }

  // Connecting a Hermes machine. Canvas-facing; on a trusted network without a
  // login yet (R-D4). The conductor token is issued only via /api/conductor/pair.
  if (path === "/api/connect") {
    if (method !== "POST") return methodNotAllowed(res, ["POST"]);
    return sendJson(res, 201, store.conductor.startPairing(harness.now()));
  }
  if (path === "/api/connection") {
    if (method === "GET") {
      const conn = store.conductor.connection();
      return sendJson(res, 200, { connected: conn !== null, createdAt: conn?.createdAt ?? null, targets: store.conductor.offeredTargets() });
    }
    if (method === "DELETE") {
      store.conductor.revoke();
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
    return methodNotAllowed(res, ["GET", "DELETE"]);
  }
  if (path === "/api/delivery-targets") {
    if (method !== "GET") return methodNotAllowed(res, ["GET"]);
    return sendJson(res, 200, { targets: store.conductor.offeredTargets() });
  }

  // The conductor's own routes. Everything but the pairing exchange needs the
  // conductor token, and the token is accepted on no other route.
  if (path === "/api/conductor/pair") {
    if (method !== "POST") return methodNotAllowed(res, ["POST"]);
    return pairConductor(req, res, store, harness);
  }
  if (path === "/api/conductor" || path.startsWith("/api/conductor/")) {
    const connectionId = store.conductor.verifyToken(bearerToken(req));
    if (connectionId === null) return sendError(res, 401, "unauthorized", "A valid conductor token is required.");
    if (path === "/api/conductor/pending") {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]);
      return sendJson(res, 200, { runs: store.runs.pending(harness.now()), serverNow: harness.now() });
    }
    if (path === "/api/conductor/targets") {
      if (method !== "PUT") return methodNotAllowed(res, ["PUT"]);
      return setConductorTargets(req, res, store, connectionId);
    }
    const claimMatch = /^\/api\/conductor\/claim\/([^/]+)$/.exec(path);
    if (claimMatch) {
      if (method !== "POST") return methodNotAllowed(res, ["POST"]);
      const runId = pathId(claimMatch[1]!);
      if (runId === null) return sendError(res, 400, "bad_request", "The run id is not valid.");
      const won = store.runs.claim(runId, harness.now());
      return sendJson(res, won ? 200 : 409, { claimed: won });
    }
    const reportMatch = /^\/api\/conductor\/report\/([^/]+)$/.exec(path);
    if (reportMatch) {
      if (method !== "POST") return methodNotAllowed(res, ["POST"]);
      const runId = pathId(reportMatch[1]!);
      if (runId === null) return sendError(res, 400, "bad_request", "The run id is not valid.");
      return reportRun(req, res, store, harness, runId);
    }
    return sendError(res, 404, "not_found", "No such route.");
  }

  const match = /^\/api\/workflows\/([^/]+)$/.exec(path);
  if (match) {
    const id = pathId(match[1]!);
    if (id === null) return sendError(res, 400, "bad_request", "The workflow id is not valid.");
    if (method === "GET") return loadWorkflow(res, store, id);
    if (method === "PUT") {
      await saveWorkflow(req, res, store, id);
      return;
    }
    if (method === "DELETE") {
      if (!store.deleteWorkflow(id)) return sendError(res, 404, "not_found", "No such workflow.");
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
    return methodNotAllowed(res, ["GET", "PUT", "DELETE"]);
  }

  sendError(res, 404, "not_found", "No such route.");
}

/**
 * Serve a file from the built UI. Paths that resolve outside the root are
 * refused, and extensionless paths fall back to index.html so the page can
 * own its own routes.
 */
async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  path: string,
): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    sendError(res, 400, "bad_request", "The request path is not valid.");
    return;
  }
  if (decoded.includes("\0")) {
    sendError(res, 400, "bad_request", "The request path is not valid.");
    return;
  }

  const requested = resolve(root, `.${decoded}`);
  if (requested !== root && !requested.startsWith(root + sep)) {
    sendError(res, 404, "not_found", "No such file.");
    return;
  }

  let file = requested;
  const info = await stat(requested).catch(() => null);
  if (!info?.isFile()) {
    if (extname(decoded) !== "") {
      sendError(res, 404, "not_found", "No such file.");
      return;
    }
    file = resolve(root, "index.html");
  }

  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    sendError(res, 404, "not_found", "No such file.");
    return;
  }

  // Vite fingerprints everything under /assets, so those never go stale.
  const immutable = decoded.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": body.length,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(method === "HEAD" ? undefined : body);
}

function methodNotAllowed(res: ServerResponse, allowed: string[]): void {
  res.setHeader("allow", allowed.join(", "));
  sendError(res, 405, "method_not_allowed", `Allowed methods: ${allowed.join(", ")}.`);
}

async function createWorkflow(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, body.status, body.code, body.message);
    return;
  }
  if (!isRecord(body.value)) {
    sendError(res, 400, "bad_request", "Request body must be a JSON object.");
    return;
  }

  const { title, description } = body.value;
  if (typeof title !== "string" || title.trim() === "" || title.length > 500) {
    sendError(res, 422, "invalid", "A workflow needs a title of 1 to 500 characters.");
    return;
  }
  if (description !== undefined && typeof description !== "string") {
    sendError(res, 422, "invalid", "Workflow description must be text.");
    return;
  }

  const { projectId } = body.value;
  if (projectId !== undefined && projectId !== null && typeof projectId !== "string") {
    sendError(res, 422, "invalid", "projectId must be a project id or null.");
    return;
  }
  const library = store.library();
  if (typeof projectId === "string" && !library.projects.some((project) => project.id === projectId)) {
    sendError(res, 422, "no_such_project", "That project does not exist.");
    return;
  }

  const created = store.create({ title, description, projectId: projectId ?? null });
  res.setHeader("location", `/api/workflows/${encodeURIComponent(created.id)}`);
  sendJson(res, 201, created);
}

/** Decode one path segment as an id, or null if it is not a valid id. */
function pathId(segment: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return id.length === 0 || id.length > MAX_ID_LENGTH ? null : id;
}

/** A project title from a request body, trimmed, or an error message. */
function projectTitle(value: unknown): { ok: true; title: string } | { ok: false; message: string } {
  if (!isRecord(value) || typeof value.title !== "string") {
    return { ok: false, message: "A project needs a title." };
  }
  const title = value.title.trim();
  if (title === "" || title.length > MAX_PROJECT_TITLE) {
    return { ok: false, message: `A project title must be 1 to ${MAX_PROJECT_TITLE} characters.` };
  }
  return { ok: true, title };
}

async function createProject(req: IncomingMessage, res: ServerResponse, store: WorkflowStore): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, body.status, body.code, body.message);
  const parsed = projectTitle(body.value);
  if (!parsed.ok) return sendError(res, 422, "invalid", parsed.message);
  sendJson(res, 201, store.createProject(parsed.title));
}

async function renameProject(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  id: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, body.status, body.code, body.message);
  const parsed = projectTitle(body.value);
  if (!parsed.ok) return sendError(res, 422, "invalid", parsed.message);
  const renamed = store.renameProject(id, parsed.title);
  if (!renamed) return sendError(res, 404, "not_found", "No such project.");
  sendJson(res, 200, renamed);
}

async function moveWorkflow(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  id: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, body.status, body.code, body.message);
  if (!isRecord(body.value)) return sendError(res, 400, "bad_request", "Request body must be a JSON object.");
  const { projectId, index } = body.value;
  if (projectId !== null && typeof projectId !== "string") {
    return sendError(res, 422, "invalid", "projectId must be a project id or null for Unfiled.");
  }
  if (!Number.isInteger(index) || (index as number) < 0) {
    return sendError(res, 422, "invalid", "index must be a whole number of 0 or more.");
  }
  const result = store.moveWorkflow(id, projectId, index as number);
  if (!result.ok) {
    return result.code === "not_found"
      ? sendError(res, 404, "not_found", "No such workflow.")
      : sendError(res, 422, "no_such_project", "That project does not exist.");
  }
  sendJson(res, 200, store.library());
}

function loadWorkflow(res: ServerResponse, store: WorkflowStore, id: string): void {
  const loaded = store.load(id);
  if (!loaded) {
    sendError(res, 404, "not_found", "No such workflow.");
    return;
  }
  sendJson(res, 200, loaded);
}

async function saveWorkflow(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  id: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, body.status, body.code, body.message);
    return;
  }
  if (!isRecord(body.value)) {
    sendError(res, 400, "bad_request", "Request body must be a JSON object.");
    return;
  }
  if (body.value.id !== id) {
    sendError(res, 400, "id_mismatch", "The workflow id in the body must match the request path.");
    return;
  }

  // The revision the client loaded is the revision it expects to replace.
  const expectedRevision =
    typeof body.value.revision === "number" ? body.value.revision : Number.NaN;

  const result = store.save(body.value as unknown as WorkflowDefinition, expectedRevision);
  if (result.ok) {
    sendJson(res, 200, result.value);
    return;
  }

  if (result.code === "invalid") {
    sendError(res, 422, "invalid", "The workflow is not valid.", result.issues);
    return;
  }
  if (result.code === "conflict") {
    sendError(
      res,
      409,
      "conflict",
      "The workflow changed since it was loaded. Reload it and reapply the edit.",
    );
    return;
  }
  sendError(res, 404, "not_found", "No such workflow.");
}

// --- Run requests (records only) ---------------------------------------------------
//
// A request freezes one revision that passed preflight. No conductor reads
// these yet, so nothing runs. The request expires so a conductor installed
// later cannot act on an old click.

function runsView(store: WorkflowStore, harness: Harness, id: string) {
  return {
    runs: store.runs.list(id, harness.now()),
    conductor: store.conductor.connection() !== null ? ("connected" as const) : ("none" as const),
    targets: store.conductor.offeredTargets(),
    requestTtlMs: REQUEST_TTL_MS,
    serverNow: harness.now(),
  };
}

async function requestRun(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  harness: Harness,
  id: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, body.status, body.code, body.message);
  if (!isRecord(body.value) || !Number.isInteger(body.value.expectedRevision)) {
    return sendError(res, 422, "invalid", "A run request names the revision it was checked against (expectedRevision).");
  }
  const current = store.load(id);
  if (!current) return sendError(res, 404, "not_found", "No such workflow.");
  if (current.revision !== body.value.expectedRevision) {
    return sendError(res, 409, "conflict", "The workflow changed since you checked it. Check it again before requesting a run.");
  }
  const now = harness.now();
  if (store.runs.active(id, now)) {
    return sendError(res, 409, "run_already_requested", "A run request for this workflow is still open. Cancel it or let it expire first.");
  }
  const plan = preflight(current, null);
  if (!plan.ok) {
    return sendError(
      res,
      422,
      "preflight_failed",
      "This workflow cannot run yet.",
      plan.issues.map((item) => ({
        code: item.code,
        path: item.cardId ? `card:${item.cardId}` : item.edgeId ? `edge:${item.edgeId}` : "workflow",
        message: item.message,
      })),
    );
  }
  if (store.conductor.connection() !== null) {
    const offered = new Set(store.conductor.offeredTargets().map((target) => target.id));
    const unknown = plan.deliveries.filter((delivery) => !offered.has(delivery.targetId));
    if (unknown.length > 0) {
      return sendError(
        res,
        422,
        "delivery_target_unknown",
        "A delivery points at a target the connected Hermes no longer offers. Choose the delivery again.",
        unknown.map((delivery) => ({ code: "delivery_target_unknown", path: `card:${delivery.cardId}`, message: "This delivery target is not offered by the connected Hermes." })),
      );
    }
  }
  const detail = store.runs.request(current, plan, now);
  res.setHeader("location", `/api/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(detail.id)}`);
  sendJson(res, 201, detail);
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : "";
}

async function approveRun(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  harness: Harness,
  id: string,
  runId: string,
): Promise<void> {
  const now = harness.now();
  if (!store.runs.get(id, runId, now)) return sendError(res, 404, "not_found", "No such run request.");
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, body.status, body.code, body.message);
  if (!isRecord(body.value) || typeof body.value.cardId !== "string" || (body.value.decision !== "approved" && body.value.decision !== "rejected")) {
    return sendError(res, 422, "invalid", "An approval names a cardId and a decision of 'approved' or 'rejected'.");
  }
  const approval = store.runs.approve(id, runId, body.value.cardId, body.value.decision, now);
  if (!approval) return sendError(res, 404, "not_found", "No such run request.");
  sendJson(res, 200, approval);
}

async function pairConductor(req: IncomingMessage, res: ServerResponse, store: WorkflowStore, harness: Harness): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, body.status, body.code, body.message);
  if (!isRecord(body.value) || typeof body.value.code !== "string") {
    return sendError(res, 422, "invalid", "Send the pairing code shown in Canvas.");
  }
  const result = store.conductor.redeemPairing(body.value.code, harness.now());
  if (!result) return sendError(res, 403, "pairing_failed", "That pairing code is not valid, has expired, or was already used.");
  sendJson(res, 201, result);
}

async function setConductorTargets(req: IncomingMessage, res: ServerResponse, store: WorkflowStore, connectionId: string): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, body.status, body.code, body.message);
  const targets = isRecord(body.value) ? body.value.targets : undefined;
  if (!store.conductor.setTargets(connectionId, targets)) {
    return sendError(res, 422, "invalid", "Targets must be a list of { id, label, kind: 'messaging' }.");
  }
  sendJson(res, 200, { ok: true });
}

async function reportRun(req: IncomingMessage, res: ServerResponse, store: WorkflowStore, harness: Harness, runId: string): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, body.status, body.code, body.message);
  if (!store.runs.report(runId, body.value, harness.now())) {
    return sendError(res, 422, "invalid_report", "The report is not a valid outcome-only report, or the run does not exist.");
  }
  sendJson(res, 200, { ok: true });
}

function cancelRun(res: ServerResponse, store: WorkflowStore, harness: Harness, id: string, runId: string): void {
  const now = harness.now();
  const before = store.runs.get(id, runId, now);
  if (!before) return sendError(res, 404, "not_found", "No such run request.");
  if (before.status !== "requested") {
    return sendError(res, 409, "run_not_open", `This request is already ${before.status}.`);
  }
  sendJson(res, 200, store.runs.cancel(id, runId, now));
}

// --- Hermes job links (read-only observation) -------------------------------------
//
// These routes store which Hermes job a workflow is linked to and pull a
// read-only observation of it. None of them can pause, resume, run, edit,
// create, or delete a job, and no request can choose a host, command, or path.

/** Everything the panel needs. `serverNow` lets a browser on another machine correct its clock. */
function harnessView(store: WorkflowStore, harness: Harness, id: string) {
  const link = store.harness.link(id);
  const latest = store.harness.latest(id);
  return {
    link,
    latestJob: latest.job,
    latestAny: latest.any,
    configured: link ? harness.config.target(link.harness, link.profile) !== null : null,
    thresholds: harness.config.thresholds,
    serverNow: harness.now(),
  };
}

async function linkJob(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkflowStore,
  harness: Harness,
  id: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, body.status, body.code, body.message);
  if (!isRecord(body.value)) return sendError(res, 400, "bad_request", "Request body must be a JSON object.");
  const { harness: label, profile, jobId } = body.value;
  if (typeof label !== "string" || !LABEL_PATTERN.test(label) || typeof profile !== "string" || !LABEL_PATTERN.test(profile)) {
    return sendError(res, 422, "invalid", "Choose a configured harness and profile.");
  }
  if (harness.config.target(label, profile) === null) {
    return sendError(res, 422, "unknown_harness", "That harness and profile are not configured on this server.");
  }
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    return sendError(res, 422, "invalid_job_id", "A Hermes job id is 6 to 32 lowercase hexadecimal characters.");
  }
  store.harness.setLink(id, label, profile, jobId, harness.now());
  sendJson(res, 200, harnessView(store, harness, id));
}

async function refreshJob(res: ServerResponse, store: WorkflowStore, harness: Harness, id: string): Promise<void> {
  const link = store.harness.link(id);
  if (!link) return sendError(res, 404, "not_linked", "This workflow is not linked to a Hermes job.");

  const running = harness.inflight.get(id);
  if (running) {
    await running;
    return sendJson(res, 200, harnessView(store, harness, id));
  }
  const now = harness.now();
  const jobKey = `${link.harness}/${link.profile}/${link.jobId}`;
  const last = Math.max(link.lastAttemptAt ?? -Infinity, harness.lastPull.get(jobKey) ?? -Infinity);
  if (Number.isFinite(last) && now - last < harness.config.minRefreshMs) {
    const wait = Math.ceil((harness.config.minRefreshMs - (now - last)) / 1000);
    res.setHeader("retry-after", String(wait));
    return sendError(res, 429, "refresh_too_soon", `This job was checked moments ago. Try again in ${wait} s.`);
  }

  harness.lastPull.set(jobKey, now);
  const pull = pullObservation(store, harness, id, link);
  harness.inflight.set(id, pull);
  try {
    await pull;
  } finally {
    harness.inflight.delete(id);
  }
  sendJson(res, 200, harnessView(store, harness, id));
}

async function pullObservation(
  store: WorkflowStore,
  harness: Harness,
  id: string,
  link: { harness: string; profile: string; jobId: string },
): Promise<void> {
  const record = (outcome: PullOutcome, observation?: Parameters<WorkflowStore["harness"]["recordPull"]>[4]) =>
    store.harness.recordPull(id, link, outcome, harness.now(), observation);

  const target = harness.config.target(link.harness, link.profile);
  if (target === null) return record("not_configured");

  const fetched = await harness.source(target, link.jobId).catch(() => ({ ok: false as const, outcome: "unreachable" as const }));
  if (!fetched.ok) return record(fetched.outcome);

  let parsed: unknown;
  try {
    parsed = JSON.parse(fetched.raw) as unknown;
  } catch {
    return record("bad_output");
  }
  const observation = parseObservation(parsed);
  if (!observation.ok) return record("bad_output");
  const value = observation.value;
  // The harness must be answering about the job and profile this link names.
  if (value.kind === "job" && value.job.jobId !== link.jobId) return record("bad_output");
  if (value.harness.profile !== link.profile) return record("bad_output");
  record("ok", { value, raw: fetched.raw, source: fetched.source });
}
