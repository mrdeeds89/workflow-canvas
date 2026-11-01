import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { REQUEST_TTL_MS, digestOf } from "../src/graph/runs.ts";
import { openStore, type WorkflowStore } from "../src/graph/store.ts";
import { createApp } from "../src/http/server.ts";
import { card } from "./fixtures.ts";

type Context = { base: string; store: WorkflowStore; clock: { now: number }; path: string };

async function withServer(run: (context: Context) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wc-runs-"));
  const path = join(dir, "canvas.sqlite");
  const store = openStore(path);
  const clock = { now: 1_800_000_000_000 };
  const server = createApp({ store, now: () => clock.now });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ base: `http://127.0.0.1:${port}`, store, clock, path });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function ready(id: string, overrides: Record<string, unknown> = {}) {
  return card(id, {
    readiness: "configured",
    instructions: `Do ${id}.`,
    run: { executor: "runner", skills: [], maxRuntimeMinutes: 30 },
    ...overrides,
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** Create a workflow and save cards into it. Returns the stored document. */
async function seeded(base: string, nodes: unknown[], edges: unknown[] = []): Promise<Record<string, unknown>> {
  const created = await json(
    await fetch(`${base}/api/workflows`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Run me" }) }),
  );
  const saved = await fetch(`${base}/api/workflows/${created.id as string}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...created, nodes, edges }),
  });
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  return json(saved);
}

function post(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("a run request freezes the checked revision, and later edits do not change it", async () => {
  await withServer(async ({ base, store }) => {
    const doc = await seeded(base, [ready("a"), ready("b")], [{ id: "e", source: "a", target: "b", type: "requires", label: "", inferred: false }]);
    const id = doc.id as string;
    const response = await post(`${base}/api/workflows/${id}/runs`, { expectedRevision: doc.revision });
    assert.equal(response.status, 201);
    const run = await json(response);
    assert.equal(run.status, "requested");
    assert.equal(run.revision, doc.revision);
    assert.equal(run.stepCount, 2);
    assert.equal(run.digest, digestOf(JSON.stringify(store.load(id))));

    // Edit after requesting.
    const current = await json(await fetch(`${base}/api/workflows/${id}`));
    const edited = await fetch(`${base}/api/workflows/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...current, title: "Changed after the request" }),
    });
    assert.equal(edited.status, 200);
    const frozen = store.runs.snapshot(id, run.id as string);
    assert.equal(frozen?.title, "Run me");
    assert.equal(frozen?.revision, doc.revision);
    const detail = await json(await fetch(`${base}/api/workflows/${id}/runs/${run.id as string}`));
    assert.equal(detail.digest, run.digest);
  });
});

test("a stale revision is 409 and records nothing", async () => {
  await withServer(async ({ base }) => {
    const doc = await seeded(base, [ready("a")]);
    const id = doc.id as string;
    const stale = await post(`${base}/api/workflows/${id}/runs`, { expectedRevision: (doc.revision as number) - 1 });
    assert.equal(stale.status, 409);
    const listing = await json(await fetch(`${base}/api/workflows/${id}/runs`));
    assert.deepEqual(listing.runs, []);
    assert.equal(listing.conductor, "none");
  });
});

test("a workflow that fails the run checks is 422 with one issue per problem", async () => {
  await withServer(async ({ base }) => {
    const doc = await seeded(base, [ready("a", { readiness: "proposed" }), ready("b", { run: { executor: "", skills: [], maxRuntimeMinutes: 30 } })]);
    const response = await post(`${base}/api/workflows/${doc.id as string}/runs`, { expectedRevision: doc.revision });
    assert.equal(response.status, 422);
    const body = (await response.json()) as { error: { code: string; issues: { code: string; path: string }[] } };
    assert.equal(body.error.code, "preflight_failed");
    assert.deepEqual(body.error.issues.map((issue) => `${issue.code}@${issue.path}`).sort(), [
      "card_not_configured@card:a",
      "executor_missing@card:b",
    ]);
    const listing = await json(await fetch(`${base}/api/workflows/${doc.id as string}/runs`));
    assert.deepEqual(listing.runs, []);
  });
});

test("one open request at a time; it can be cancelled, and it expires by itself", async () => {
  await withServer(async ({ base, clock }) => {
    const doc = await seeded(base, [ready("a")]);
    const url = `${base}/api/workflows/${doc.id as string}/runs`;
    const first = await json(await post(url, { expectedRevision: doc.revision }));
    const second = await post(url, { expectedRevision: doc.revision });
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { error: { code: string } }).error.code, "run_already_requested");

    const cancelled = await post(`${url}/${first.id as string}/cancel`);
    assert.equal(cancelled.status, 200);
    assert.equal((await json(cancelled)).status, "cancelled");
    assert.equal((await post(`${url}/${first.id as string}/cancel`)).status, 409);

    const third = await json(await post(url, { expectedRevision: doc.revision }));
    clock.now += REQUEST_TTL_MS;
    const listing = (await json(await fetch(url))) as { runs: { id: string; status: string }[] };
    assert.deepEqual(listing.runs.map((run) => [run.id, run.status]), [
      [third.id, "expired"],
      [first.id, "cancelled"],
    ]);
    // An expired request cannot be cancelled into looking fresh, and a new one is allowed.
    assert.equal((await post(`${url}/${third.id as string}/cancel`)).status, 409);
    assert.equal((await post(url, { expectedRevision: doc.revision })).status, 201);
  });
});

test("a run request does not change the workflow or its revision", async () => {
  await withServer(async ({ base }) => {
    const doc = await seeded(base, [ready("a")]);
    const id = doc.id as string;
    const before = await (await fetch(`${base}/api/workflows/${id}`)).text();
    assert.equal((await post(`${base}/api/workflows/${id}/runs`, { expectedRevision: doc.revision })).status, 201);
    const after = await (await fetch(`${base}/api/workflows/${id}`)).text();
    assert.equal(after, before);
  });
});

test("bad bodies and unknown ids are refused; there is still no run or execute route", async () => {
  await withServer(async ({ base }) => {
    const doc = await seeded(base, [ready("a")]);
    const id = doc.id as string;
    assert.equal((await post(`${base}/api/workflows/${id}/runs`, { expectedRevision: "1" })).status, 422);
    assert.equal((await post(`${base}/api/workflows/${id}/runs`, {})).status, 422);
    // No body at all: refused before anything is read.
    assert.equal((await post(`${base}/api/workflows/${id}/runs`)).status, 415);
    assert.equal((await post(`${base}/api/workflows/missing/runs`, { expectedRevision: 1 })).status, 404);
    assert.equal((await fetch(`${base}/api/workflows/${id}/runs/missing`)).status, 404);
    assert.equal((await post(`${base}/api/workflows/${id}/runs/missing/cancel`)).status, 404);
    assert.equal((await fetch(`${base}/api/workflows/${id}/runs`, { method: "DELETE" })).status, 405);
    for (const path of [`/api/workflows/${id}/run`, `/api/workflows/${id}/execute`, `/api/workflows/${id}/runs/x/start`]) {
      assert.equal((await post(`${base}${path}`)).status, 404, path);
    }
    assert.deepEqual(await json(await fetch(`${base}/api/health`)), { status: "ok", execution: "disabled" });
  });
});

test("requests survive a restart; an open run blocks delete until stopped; duplicates start with none", async () => {
  await withServer(async ({ base, path }) => {
    const doc = await seeded(base, [ready("a")]);
    const id = doc.id as string;
    const run = await json(await post(`${base}/api/workflows/${id}/runs`, { expectedRevision: doc.revision }));

    const reopened = openStore(path);
    try {
      assert.equal(reopened.runs.get(id, run.id as string, 1_800_000_000_000)?.status, "requested");
    } finally {
      reopened.close();
    }

    const copy = await json(await post(`${base}/api/workflows/${id}/duplicate`));
    assert.deepEqual((await json(await fetch(`${base}/api/workflows/${copy.id as string}/runs`))).runs, []);

    // A workflow with an open (unfinished) run cannot be deleted until it is stopped.
    assert.equal((await fetch(`${base}/api/workflows/${id}`, { method: "DELETE" })).status, 409);
    await post(`${base}/api/workflows/${id}/runs/${run.id as string}/cancel`);
    assert.equal((await fetch(`${base}/api/workflows/${id}`, { method: "DELETE" })).status, 204);
    const db = new DatabaseSync(path);
    try {
      const count = db.prepare("SELECT COUNT(*) AS n FROM run_requests WHERE workflow_id = ?").get(id) as { n: number };
      assert.equal(count.n, 0);
    } finally {
      db.close();
    }
  });
});
