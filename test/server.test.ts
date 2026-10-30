import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore, type WorkflowStore } from "../src/graph/store.ts";
import { SCHEMA_VERSION } from "../src/graph/types.ts";
import { createApp, MAX_BODY_BYTES } from "../src/http/server.ts";
import { card, setupTask } from "./fixtures.ts";

type Context = { base: string; store: WorkflowStore };

async function withServer(
  run: (context: Context) => Promise<void>,
  allowedOrigins: string[] = [],
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wc-http-"));
  const store = openStore(join(dir, "canvas.sqlite"));
  const server = createApp({ store, allowedOrigins });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ base: `http://127.0.0.1:${port}`, store });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function postJson(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function putJson(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function taskNode(id: string, title: string) {
  return card(id, { title, owner: "human", position: { x: 40, y: 80 } });
}

async function createWorkflow(base: string, title = "Research") {
  const response = await postJson(base, "/api/workflows", { title });
  assert.equal(response.status, 201);
  return (await response.json()) as Record<string, unknown>;
}

test("health reports status without claiming execution support", async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", execution: "disabled" });
  });
});

test("creates a workflow, then reloads it through the API", async () => {
  await withServer(async ({ base }) => {
    const created = await createWorkflow(base, "Research");
    assert.equal(created.title, "Research");
    assert.equal(created.revision, 1);
    assert.equal(created.schemaVersion, SCHEMA_VERSION);

    const loaded = await fetch(`${base}/api/workflows/${created.id as string}`);
    assert.equal(loaded.status, 200);
    assert.deepEqual(await loaded.json(), created);
  });
});

test("saves an edit, bumps the revision, and returns it on the next load", async () => {
  await withServer(async ({ base }) => {
    const created = await createWorkflow(base);
    const edited = { ...created, nodes: [taskNode("read", "Read the source")] };

    const saved = await putJson(base, `/api/workflows/${created.id as string}`, edited);
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as Record<string, unknown>;
    assert.equal(savedBody.revision, 2);

    const reloaded = await fetch(`${base}/api/workflows/${created.id as string}`);
    const reloadedBody = (await reloaded.json()) as Record<string, unknown>;
    assert.equal(reloadedBody.revision, 2);
    const nodes = reloadedBody.nodes as Record<string, unknown>[];
    assert.equal(nodes[0]?.title, "Read the source");
    assert.deepEqual(nodes[0]?.position, { x: 40, y: 80 });
  });
});

test("rejects a second save of the revision the client already replaced", async () => {
  await withServer(async ({ base }) => {
    const created = await createWorkflow(base);
    const first = await putJson(base, `/api/workflows/${created.id as string}`, created);
    assert.equal(first.status, 200);

    const stale = await putJson(base, `/api/workflows/${created.id as string}`, created);
    assert.equal(stale.status, 409);
    const body = (await stale.json()) as { error: { code: string } };
    assert.equal(body.error.code, "conflict");

    const loaded = await fetch(`${base}/api/workflows/${created.id as string}`);
    assert.equal(((await loaded.json()) as Record<string, unknown>).revision, 2);
  });
});

test("rejects a dangling edge with reportable issues and leaves the stored graph intact", async () => {
  await withServer(async ({ base }) => {
    const created = await createWorkflow(base);
    const broken = {
      ...created,
      edges: [
        { id: "e-1", source: "missing", target: "gone", type: "requires", label: "", inferred: false },
      ],
    };

    const response = await putJson(base, `/api/workflows/${created.id as string}`, broken);
    assert.equal(response.status, 422);
    const body = (await response.json()) as {
      error: { code: string; issues?: { code: string }[] };
    };
    assert.equal(body.error.code, "invalid");
    assert.ok(body.error.issues?.some((issue) => issue.code === "dangling_edge"));

    const loaded = await fetch(`${base}/api/workflows/${created.id as string}`);
    const loadedBody = (await loaded.json()) as Record<string, unknown>;
    assert.equal(loadedBody.revision, 1);
    assert.equal((loadedBody.edges as unknown[]).length, 0);
  });
});

test("stores imported text as data and drops unknown fields such as runCommand", async () => {
  await withServer(async ({ base }) => {
    const created = await createWorkflow(base);
    const edited = {
      ...created,
      nodes: [
        {
          ...taskNode("a", "<script>alert(1)</script>"),
          instructions: "Do not execute: $(rm -rf /)",
          runCommand: "rm -rf /",
        },
      ],
    };

    const saved = await putJson(base, `/api/workflows/${created.id as string}`, edited);
    assert.equal(saved.status, 200);

    const loaded = await fetch(`${base}/api/workflows/${created.id as string}`);
    const node = ((await loaded.json()) as { nodes: Record<string, unknown>[] }).nodes[0]!;
    assert.equal(node.title, "<script>alert(1)</script>");
    assert.equal(node.instructions, "Do not execute: $(rm -rf /)");
    assert.equal("runCommand" in node, false);
  });
});

test("refuses to record readiness that only a real run could establish", async () => {
  await withServer(async ({ base }) => {
    const created = await createWorkflow(base);
    for (const readiness of ["tested", "operational"]) {
      const response = await putJson(base, `/api/workflows/${created.id as string}`, {
        ...created,
        nodes: [card("a", { readiness })],
      });
      assert.equal(response.status, 422, `${readiness} must be refused`);
      const body = (await response.json()) as { error: { issues?: { code: string }[] } };
      assert.ok(
        body.error.issues?.some((issue) => issue.code === "readiness_requires_run_evidence"),
        `${readiness} should report readiness_requires_run_evidence`,
      );
    }

    // The stored graph is untouched by the refused edits.
    const loaded = await fetch(`${base}/api/workflows/${created.id as string}`);
    assert.equal(((await loaded.json()) as Record<string, unknown>).revision, 1);
  });
});

test("refuses a setup task link that could execute script", async () => {
  await withServer(async ({ base }) => {
    const created = await createWorkflow(base);
    const response = await putJson(base, `/api/workflows/${created.id as string}`, {
      ...created,
      nodes: [card("a", { setup: [setupTask("s1", { link: "javascript:alert(1)" })] })],
    });
    assert.equal(response.status, 422);
    const body = (await response.json()) as { error: { issues?: { code: string }[] } };
    assert.ok(body.error.issues?.some((issue) => issue.code === "unsafe_link"));
  });
});

test("round-trips card ownership and setup progress", async () => {
  await withServer(async ({ base }) => {
    const created = await createWorkflow(base);
    const proposal = {
      agentOwns: ["Write the draft from the research only"],
      youOwn: ["Set tone, length and audience"],
    };
    const saved = await putJson(base, `/api/workflows/${created.id as string}`, {
      ...created,
      nodes: [
        card("draft", {
          type: "agent",
          title: "Draft agent",
          readiness: "configured",
          proposal,
          setup: [
            setupTask("s1", {
              text: "Pick the review model",
              detail: "Use a different model from the draft agent so the review is independent.",
              link: "https://hermes-agent.nousresearch.com/docs",
              done: true,
            }),
          ],
        }),
      ],
    });
    assert.equal(saved.status, 200);

    const loaded = await fetch(`${base}/api/workflows/${created.id as string}`);
    const node = ((await loaded.json()) as { nodes: Record<string, unknown>[] }).nodes[0]!;
    assert.equal(node.type, "agent");
    assert.equal(node.readiness, "configured");
    assert.deepEqual(node.proposal, proposal);
    const setup = node.setup as Record<string, unknown>[];
    assert.equal(setup[0]?.detail, "Use a different model from the draft agent so the review is independent.");
    assert.equal(setup[0]?.link, "https://hermes-agent.nousresearch.com/docs");
    assert.equal(setup[0]?.done, true);
  });
});

test("derives configured from the checklist across saves", async () => {
  await withServer(async ({ base }) => {
    const created = await createWorkflow(base);
    const path = `/api/workflows/${created.id as string}`;

    // Approve the card with every task checked: the server stores configured.
    const ticked = await putJson(base, path, {
      ...created,
      nodes: [card("a", { readiness: "not_configured", setup: [setupTask("s1", { done: true })] })],
    });
    assert.equal(ticked.status, 200);
    const afterTick = (await ticked.json()) as Record<string, unknown> & { nodes: Record<string, unknown>[] };
    assert.equal(afterTick.nodes[0]?.readiness, "configured");

    // Reopen the task while still sending configured: the server corrects it.
    const reopened = await putJson(base, path, {
      ...afterTick,
      nodes: [card("a", { readiness: "configured", setup: [setupTask("s1", { done: false })] })],
    });
    assert.equal(reopened.status, 200, "a stale configured claim must be corrected, not refused");

    const loaded = await fetch(`${base}${path}`);
    const node = ((await loaded.json()) as { nodes: Record<string, unknown>[] }).nodes[0]!;
    assert.equal(node.readiness, "not_configured");
  });
});

test("rejects a body whose id does not match the request path", async () => {
  await withServer(async ({ base }) => {
    const created = await createWorkflow(base);
    const response = await putJson(base, `/api/workflows/${created.id as string}`, {
      ...created,
      id: "someone-elses-workflow",
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "id_mismatch");
  });
});

test("requires a usable title when creating a workflow", async () => {
  await withServer(async ({ base }) => {
    for (const title of ["", "   ", 42, undefined]) {
      const response = await postJson(base, "/api/workflows", { title });
      assert.equal(response.status, 422, `title ${JSON.stringify(title)} should be rejected`);
    }
  });
});

test("returns 404 for an unknown workflow and an unknown route", async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/workflows/does-not-exist`)).status, 404);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 404);
  });
});

test("exposes no execution route", async () => {
  await withServer(async ({ base }) => {
    const created = await createWorkflow(base);
    const id = created.id as string;
    for (const path of [`/api/workflows/${id}/run`, `/api/workflows/${id}/execute`, "/api/run"]) {
      const response = await postJson(base, path, {});
      assert.equal(response.status, 404, `${path} must not exist`);
    }
  });
});

test("rejects unsupported methods with an Allow header", async () => {
  await withServer(async ({ base }) => {
    const created = await createWorkflow(base);
    const response = await fetch(`${base}/api/workflows/${created.id as string}`, {
      method: "DELETE",
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, PUT");

    const collection = await fetch(`${base}/api/workflows`, { method: "GET" });
    assert.equal(collection.status, 405);
    assert.equal(collection.headers.get("allow"), "POST");
  });
});

test("rejects a non-JSON content type and malformed JSON", async () => {
  await withServer(async ({ base }) => {
    const wrongType = await fetch(`${base}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "title=Research",
    });
    assert.equal(wrongType.status, 415);

    const malformed = await fetch(`${base}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(malformed.status, 400);
    assert.equal(
      ((await malformed.json()) as { error: { code: string } }).error.code,
      "malformed_json",
    );
  });
});

test("rejects an oversized payload", async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x".repeat(MAX_BODY_BYTES + 1_000) }),
    });
    assert.equal(response.status, 413);
  });
});

test("denies an unlisted browser origin and allows a configured one", async () => {
  await withServer(
    async ({ base }) => {
      const denied = await postJson(
        base,
        "/api/workflows",
        { title: "Research" },
        { origin: "https://evil.example" },
      );
      assert.equal(denied.status, 403);
      assert.equal(
        ((await denied.json()) as { error: { code: string } }).error.code,
        "forbidden_origin",
      );

      const allowed = await postJson(
        base,
        "/api/workflows",
        { title: "Research" },
        { origin: "http://127.0.0.1:5173" },
      );
      assert.equal(allowed.status, 201);
    },
    ["http://127.0.0.1:5173"],
  );
});
