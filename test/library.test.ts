import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore, type Library, type WorkflowStore } from "../src/graph/store.ts";
import { SCHEMA_VERSION } from "../src/graph/types.ts";
import { createApp } from "../src/http/server.ts";
import { card } from "./fixtures.ts";

function withStore(run: (store: WorkflowStore, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "wc-lib-"));
  const path = join(dir, "canvas.sqlite");
  const store = openStore(path);
  try {
    run(store, path);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Titles per list, in order: { Unfiled: [...], <project title>: [...] }. */
function lists(library: Library): Record<string, string[]> {
  const names = new Map(library.projects.map((project) => [project.id, project.title]));
  const out: Record<string, string[]> = { Unfiled: [] };
  for (const project of library.projects) out[project.title] = [];
  for (const workflow of library.workflows) {
    out[workflow.projectId === null ? "Unfiled" : names.get(workflow.projectId)!]!.push(workflow.title);
  }
  return out;
}

test("new workflows go to the top of their list", () => {
  withStore((store) => {
    store.create({ title: "A" });
    store.create({ title: "B" });
    const kalshi = store.createProject("Kalshi");
    store.create({ title: "K1", projectId: kalshi.id });
    store.create({ title: "K2", projectId: kalshi.id });
    assert.deepEqual(lists(store.library()), { Unfiled: ["B", "A"], Kalshi: ["K2", "K1"] });
  });
});

test("creating in a missing project is refused", () => {
  withStore((store) => {
    assert.throws(() => store.create({ title: "x", projectId: "nope" }));
    assert.equal(store.library().workflows.length, 0);
  });
});

test("projects keep creation order and can be renamed", () => {
  withStore((store) => {
    const a = store.createProject("Kalshi");
    store.createProject("Robinhood");
    assert.deepEqual(store.renameProject(a.id, "Kalshi research"), { id: a.id, title: "Kalshi research" });
    assert.equal(store.renameProject("missing", "x"), null);
    assert.deepEqual(
      store.library().projects.map((project) => project.title),
      ["Kalshi research", "Robinhood"],
    );
  });
});

test("reorders within a list and moves between lists without touching revisions", () => {
  withStore((store) => {
    const ideas = store.createProject("Ideas");
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B" });
    const c = store.create({ title: "C" });
    // Unfiled is now C, B, A.
    assert.deepEqual(store.moveWorkflow(a.id, null, 0), { ok: true });
    assert.deepEqual(lists(store.library()).Unfiled, ["A", "C", "B"]);

    assert.deepEqual(store.moveWorkflow(c.id, ideas.id, 0), { ok: true });
    assert.deepEqual(store.moveWorkflow(b.id, ideas.id, 99), { ok: true });
    assert.deepEqual(lists(store.library()), { Unfiled: ["A"], Ideas: ["C", "B"] });

    assert.equal(store.load(c.id)?.revision, 1, "moving must not change the document revision");
    assert.deepEqual(store.moveWorkflow("missing", null, 0), { ok: false, code: "not_found" });
    assert.deepEqual(store.moveWorkflow(a.id, "missing", 0), { ok: false, code: "no_such_project" });
    assert.deepEqual(lists(store.library()), { Unfiled: ["A"], Ideas: ["C", "B"] });
  });
});

test("deletes a workflow and closes the gap in its list", () => {
  withStore((store) => {
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B" });
    store.create({ title: "C" });
    assert.equal(store.deleteWorkflow(b.id), true);
    assert.equal(store.deleteWorkflow(b.id), false);
    assert.equal(store.load(b.id), null);
    assert.deepEqual(lists(store.library()).Unfiled, ["C", "A"]);
    assert.deepEqual(store.moveWorkflow(a.id, null, 0), { ok: true });
    assert.deepEqual(lists(store.library()).Unfiled, ["A", "C"]);
  });
});

test("duplicates a workflow as an independent copy right after the original", () => {
  withStore((store) => {
    const project = store.createProject("Ideas");
    store.create({ title: "Other", projectId: project.id });
    const original = store.create({ title: "Research", projectId: project.id });
    const saved = store.save({ ...original, nodes: [card("n", { title: "Step" }) as never] }, 1);
    assert.equal(saved.ok, true);

    const copy = store.duplicateWorkflow(original.id);
    assert.ok(copy);
    assert.notEqual(copy.id, original.id);
    assert.equal(copy.title, "Research (copy)");
    assert.equal(copy.revision, 1);
    assert.equal(copy.nodes[0]?.title, "Step");
    assert.deepEqual(lists(store.library()).Ideas, ["Research", "Research (copy)", "Other"]);

    // Editing the copy leaves the original alone.
    const edited = store.save({ ...copy, nodes: [] }, 1);
    assert.equal(edited.ok, true);
    assert.equal(store.load(original.id)?.nodes.length, 1);
    assert.equal(store.duplicateWorkflow("missing"), null);
  });
});

test("upgrades a database created before projects, keeping workflows as Unfiled", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-old-"));
  const path = join(dir, "canvas.sqlite");
  try {
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE workflows (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL)");
    const insert = old.prepare("INSERT INTO workflows (id, revision, document) VALUES (?, ?, ?)");
    for (const [id, title] of [["w1", "First"], ["w2", "Second"]] as const) {
      const doc = {
        schemaVersion: SCHEMA_VERSION, id, title, description: "", revision: 3,
        nodes: [], edges: [], groups: [], sourceReferences: [],
      };
      insert.run(id, 3, JSON.stringify(doc));
    }
    old.close();

    const store = openStore(path);
    try {
      assert.deepEqual(lists(store.library()), { Unfiled: ["First", "Second"] });
      assert.equal(store.load("w1")?.revision, 3);
      const fresh = store.create({ title: "New" });
      assert.deepEqual(lists(store.library()).Unfiled, ["New", "First", "Second"]);
      assert.equal(store.load(fresh.id)?.title, "New");
    } finally {
      store.close();
    }
    // Opening again must not re-run the upgrade or reorder anything.
    const again = openStore(path);
    assert.deepEqual(lists(again.library()).Unfiled, ["New", "First", "Second"]);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ HTTP

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wc-lib-http-"));
  const store = openStore(join(dir, "canvas.sqlite"));
  const server = createApp({ store });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function send(base: string, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("library API: projects, create into a project, move, duplicate, delete", async () => {
  await withServer(async (base) => {
    const project = await send(base, "POST", "/api/projects", { title: "  Kalshi  " });
    assert.equal(project.status, 201);
    const { id: projectId, title } = (await project.json()) as { id: string; title: string };
    assert.equal(title, "Kalshi", "project titles are trimmed");

    const a = (await (await send(base, "POST", "/api/workflows", { title: "A", projectId })).json()) as { id: string };
    const b = (await (await send(base, "POST", "/api/workflows", { title: "B" })).json()) as { id: string };

    let library = (await (await send(base, "GET", "/api/library")).json()) as Library;
    assert.deepEqual(lists(library), { Unfiled: ["B"], Kalshi: ["A"] });

    const moved = await send(base, "POST", `/api/workflows/${b.id}/move`, { projectId, index: 1 });
    assert.equal(moved.status, 200);
    assert.deepEqual(lists((await moved.json()) as Library), { Unfiled: [], Kalshi: ["A", "B"] });

    const copy = await send(base, "POST", `/api/workflows/${a.id}/duplicate`);
    assert.equal(copy.status, 201);
    assert.equal(((await copy.json()) as { title: string }).title, "A (copy)");

    assert.equal((await send(base, "DELETE", `/api/workflows/${b.id}`)).status, 204);
    assert.equal((await send(base, "GET", `/api/workflows/${b.id}`)).status, 404);
    assert.equal((await send(base, "DELETE", `/api/workflows/${b.id}`)).status, 404);

    const renamed = await send(base, "PATCH", `/api/projects/${projectId}`, { title: "Kalshi research" });
    assert.equal(renamed.status, 200);
    library = (await (await send(base, "GET", "/api/library")).json()) as Library;
    assert.deepEqual(lists(library), { Unfiled: [], "Kalshi research": ["A", "A (copy)"] });
  });
});

test("library API refuses bad input", async () => {
  await withServer(async (base) => {
    const w = (await (await send(base, "POST", "/api/workflows", { title: "W" })).json()) as { id: string };
    assert.equal((await send(base, "POST", "/api/projects", { title: "   " })).status, 422);
    assert.equal((await send(base, "POST", "/api/projects", { title: "x".repeat(201) })).status, 422);
    assert.equal((await send(base, "PATCH", "/api/projects/missing", { title: "x" })).status, 404);
    assert.equal((await send(base, "POST", "/api/workflows", { title: "x", projectId: "missing" })).status, 422);
    assert.equal((await send(base, "POST", `/api/workflows/${w.id}/move`, { projectId: "missing", index: 0 })).status, 422);
    assert.equal((await send(base, "POST", `/api/workflows/${w.id}/move`, { projectId: null, index: -1 })).status, 422);
    assert.equal((await send(base, "POST", `/api/workflows/${w.id}/move`, { index: 0 })).status, 422);
    assert.equal((await send(base, "POST", "/api/workflows/missing/move", { projectId: null, index: 0 })).status, 404);
    assert.equal((await send(base, "POST", "/api/workflows/missing/duplicate")).status, 404);
    assert.equal((await send(base, "GET", `/api/workflows/${w.id}/duplicate`)).status, 405);
    assert.equal((await send(base, "PUT", "/api/library")).status, 405);
  });
});
