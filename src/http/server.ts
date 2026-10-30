import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { WorkflowStore } from "../graph/store.ts";
import type { ValidationIssue, WorkflowDefinition } from "../graph/types.ts";

/**
 * Private design-time API over the workflow store.
 *
 * This service stores and returns workflow definitions. It never interprets
 * node instructions, edge labels, or any other imported text as a command,
 * and it exposes no execution route.
 */

export const MAX_BODY_BYTES = 1_000_000;
const MAX_ID_LENGTH = 128;

export type AppOptions = {
  store: WorkflowStore;
  /** Browser origins allowed to call this API. Default deny for any other origin. */
  allowedOrigins?: string[];
  /** Built canvas UI to serve for non-API paths. Omit to serve the API only. */
  staticDir?: string;
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

export function createApp({ store, allowedOrigins = [], staticDir }: AppOptions): Server {
  const staticRoot = staticDir === undefined ? undefined : resolve(staticDir);
  return createServer((req, res) => {
    void handle(req, res, store, allowedOrigins, staticRoot).catch(() => {
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

  const match = /^\/api\/workflows\/([^/]+)$/.exec(path);
  if (match) {
    let id: string;
    try {
      id = decodeURIComponent(match[1]!);
    } catch {
      sendError(res, 400, "bad_request", "The workflow id is not valid.");
      return;
    }
    if (id.length === 0 || id.length > MAX_ID_LENGTH) {
      sendError(res, 400, "bad_request", "The workflow id is not valid.");
      return;
    }
    if (method === "GET") return loadWorkflow(res, store, id);
    if (method === "PUT") {
      await saveWorkflow(req, res, store, id);
      return;
    }
    return methodNotAllowed(res, ["GET", "PUT"]);
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

  const created = store.create({ title, description });
  res.setHeader("location", `/api/workflows/${encodeURIComponent(created.id)}`);
  sendJson(res, 201, created);
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
