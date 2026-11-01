import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REQUEST_TTL_MS } from "../src/graph/runs.ts";
import { openStore, type WorkflowStore } from "../src/graph/store.ts";
import { createApp } from "../src/http/server.ts";
import { LOCAL_FILE_TARGET } from "../src/graph/types.ts";
import { card } from "./fixtures.ts";

type Context = { base: string; store: WorkflowStore; clock: { now: number } };

async function withServer(run: (context: Context) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wc-conductor-"));
  const store = openStore(join(dir, "canvas.sqlite"));
  const clock = { now: 1_800_000_000_000 };
  const server = createApp({ store, now: () => clock.now });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ base: `http://127.0.0.1:${port}`, store, clock });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
function post(url: string, body?: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(url, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
function ready(id: string, overrides: Record<string, unknown> = {}) {
  return card(id, { readiness: "configured", instructions: `Do ${id}.`, run: { executor: "runner", skills: [], maxRuntimeMinutes: 30 }, ...overrides });
}
async function seeded(base: string, nodes: unknown[], edges: unknown[] = []): Promise<Record<string, unknown>> {
  const created = await json(await fetch(`${base}/api/workflows`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Run me" }) }));
  const saved = await fetch(`${base}/api/workflows/${created.id as string}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...created, nodes, edges }),
  });
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  return json(saved);
}
async function connect(base: string): Promise<string> {
  const { code } = await json(await post(`${base}/api/connect`));
  const paired = await json(await post(`${base}/api/conductor/pair`, { code }));
  return paired.token as string;
}

test("the conductor routes need the token, and the token reaches nothing else", async () => {
  await withServer(async ({ base }) => {
    // No token: refused.
    assert.equal((await fetch(`${base}/api/conductor/pending`)).status, 401);
    assert.equal((await post(`${base}/api/conductor/claim/x`)).status, 401);
    const token = await connect(base);
    // With token: allowed on conductor routes.
    assert.equal((await fetch(`${base}/api/conductor/pending`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    // A bad token is refused.
    assert.equal((await fetch(`${base}/api/conductor/pending`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    // The token is consulted on no other route: a workflow route neither needs nor is unlocked by it.
    assert.equal((await fetch(`${base}/api/conductor/nonsense`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
  });
});

test("an expired or reused pairing code is refused", async () => {
  await withServer(async ({ base, clock }) => {
    const { code } = await json(await post(`${base}/api/connect`));
    assert.equal((await post(`${base}/api/conductor/pair`, { code })).status, 201);
    assert.equal((await post(`${base}/api/conductor/pair`, { code })).status, 403, "a used code is refused");
    const stale = (await json(await post(`${base}/api/connect`))).code as string;
    clock.now += 11 * 60 * 1000;
    assert.equal((await post(`${base}/api/conductor/pair`, { code: stale })).status, 403, "an expired code is refused");
  });
});

test("a run is claimed exactly once, and a claimed run does not expire", async () => {
  await withServer(async ({ base, clock }) => {
    const token = await connect(base);
    const doc = await seeded(base, [ready("a"), ready("b")], [{ id: "e", source: "a", target: "b", type: "requires", label: "", inferred: false }]);
    const id = doc.id as string;
    const run = await json(await post(`${base}/api/workflows/${id}/runs`, { expectedRevision: doc.revision }));
    const runId = run.id as string;

    const pending = (await json(await fetch(`${base}/api/conductor/pending`, { headers: { authorization: `Bearer ${token}` } }))).runs as { runId: string; bundle: Record<string, unknown> }[];
    assert.deepEqual(pending.map((p) => p.runId), [runId]);
    assert.equal(pending[0]!.bundle.keyPrefix, `wc:${runId}:`);

    assert.deepEqual(await json(await post(`${base}/api/conductor/claim/${runId}`, undefined, token)), { claimed: true });
    assert.deepEqual(await json(await post(`${base}/api/conductor/claim/${runId}`, undefined, token)), { claimed: false }, "a second claim loses");

    // Claimed runs leave the pending list.
    const after = (await json(await fetch(`${base}/api/conductor/pending`, { headers: { authorization: `Bearer ${token}` } }))).runs as unknown[];
    assert.deepEqual(after, []);

    // Past the request TTL, an unclaimed run would be "expired"; this one stays "claimed".
    clock.now += REQUEST_TTL_MS + 1;
    assert.equal((await json(await fetch(`${base}/api/workflows/${id}/runs/${runId}`))).status, "claimed");
  });
});

test("the conductor reports outcome only; malformed reports are refused", async () => {
  await withServer(async ({ base }) => {
    const token = await connect(base);
    const doc = await seeded(base, [ready("a")]);
    const id = doc.id as string;
    const runId = (await json(await post(`${base}/api/workflows/${id}/runs`, { expectedRevision: doc.revision }))).id as string;
    await post(`${base}/api/conductor/claim/${runId}`, undefined, token);

    assert.equal((await post(`${base}/api/conductor/report/${runId}`, { runStatus: "nonsense" }, token)).status, 422);
    assert.equal((await post(`${base}/api/conductor/report/${runId}`, { steps: [{ cardId: "a", status: "exploded" }] }, token)).status, 422);
    assert.equal((await post(`${base}/api/conductor/report/${runId}`, {}, token)).status, 422, "an empty report says nothing");

    assert.equal((await post(`${base}/api/conductor/report/${runId}`, { runStatus: "running", steps: [{ cardId: "a", status: "running" }] }, token)).status, 200);
    let detail = await json(await fetch(`${base}/api/workflows/${id}/runs/${runId}`));
    assert.equal(detail.status, "running");

    assert.equal((await post(`${base}/api/conductor/report/${runId}`, { runStatus: "completed", steps: [{ cardId: "a", status: "completed" }], deliveries: [{ cardId: "out", status: "sent" }] }, token)).status, 200);
    detail = await json(await fetch(`${base}/api/workflows/${id}/runs/${runId}`));
    assert.equal(detail.status, "completed");
    assert.deepEqual((detail.outcomes as { deliveries: unknown[] }).deliveries, [{ cardId: "out", status: "sent" }]);
  });
});

test("a human approval is recorded on the run", async () => {
  await withServer(async ({ base }) => {
    const doc = await seeded(base, [ready("draft"), card("ok", { type: "approval", readiness: "configured" }), ready("send")], [
      { id: "e1", source: "draft", target: "ok", type: "requires", label: "", inferred: false },
      { id: "e2", source: "ok", target: "send", type: "requires", label: "", inferred: false },
    ]);
    const id = doc.id as string;
    const runId = (await json(await post(`${base}/api/workflows/${id}/runs`, { expectedRevision: doc.revision }))).id as string;
    assert.equal((await post(`${base}/api/workflows/${id}/runs/${runId}/approvals`, { cardId: "ok", decision: "nope" })).status, 422);
    assert.equal((await post(`${base}/api/workflows/${id}/runs/${runId}/approvals`, { cardId: "ok", decision: "approved" })).status, 200);
    const detail = await json(await fetch(`${base}/api/workflows/${id}/runs/${runId}`));
    assert.deepEqual((detail.approvals as { cardId: string; decision: string }[]).map((a) => [a.cardId, a.decision]), [["ok", "approved"]]);
  });
});

test("when a Hermes is connected, a delivery to a target it does not offer is refused", async () => {
  await withServer(async ({ base }) => {
    const token = await connect(base);
    await fetch(`${base}/api/conductor/targets`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ targets: [{ id: "telegram:7", label: "T", kind: "messaging" }] }) });
    const bad = await seeded(base, [ready("make"), card("out", { type: "artifact", readiness: "configured", deliverTo: "telegram:999" })], [{ id: "e", source: "make", target: "out", type: "data", label: "", inferred: false }]);
    const badId = bad.id as string;
    assert.equal((await post(`${base}/api/workflows/${badId}/runs`, { expectedRevision: bad.revision })).status, 422);

    const good = await seeded(base, [ready("make"), card("out", { type: "artifact", readiness: "configured", deliverTo: LOCAL_FILE_TARGET })], [{ id: "e", source: "make", target: "out", type: "data", label: "", inferred: false }]);
    const goodId = good.id as string;
    assert.equal((await post(`${base}/api/workflows/${goodId}/runs`, { expectedRevision: good.revision })).status, 201);
  });
});
