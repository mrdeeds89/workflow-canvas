import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateToCurrent } from "../src/graph/migrate.ts";
import { openStore } from "../src/graph/store.ts";
import { SCHEMA_VERSION } from "../src/graph/types.ts";
import { validateWorkflow } from "../src/graph/validate.ts";
import { emptyWorkflow, v1Node, v1Workflow } from "./fixtures.ts";

function migrated(input: unknown): Record<string, unknown> {
  const result = migrateToCurrent(input);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("migration failed");
  return result.value as Record<string, unknown>;
}

function firstNode(document: Record<string, unknown>): Record<string, unknown> {
  return (document.nodes as Record<string, unknown>[])[0]!;
}

test("migrates a v1 document to the current schema version", () => {
  const result = migrateToCurrent(v1Workflow());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.from, 1);
    assert.equal(result.to, SCHEMA_VERSION);
    assert.equal(result.migrated, true);
    assert.equal((result.value as Record<string, unknown>).schemaVersion, SCHEMA_VERSION);
  }
});

test("leaves a current-version document untouched", () => {
  const result = migrateToCurrent(emptyWorkflow());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.migrated, false);
});

test("rejects a schema version it cannot read", () => {
  for (const schemaVersion of [0, 99, "1", undefined]) {
    const result = migrateToCurrent({ ...emptyWorkflow(), schemaVersion });
    assert.equal(result.ok, false, `version ${String(schemaVersion)} should be unreadable`);
  }
});

test("renames the v1 gate card to an approval card", () => {
  const document = migrated(v1Workflow({ nodes: [v1Node("g", { type: "gate" })] }));
  assert.equal(firstNode(document).type, "approval");
});

test("carries a v1 checklist across to the setup checklist", () => {
  const document = migrated(
    v1Workflow({
      nodes: [
        v1Node("a", {
          checklist: [{ id: "c1", text: "Pick the review model", done: false }],
        }),
      ],
    }),
  );
  const node = firstNode(document);
  assert.equal("checklist" in node, false);
  assert.deepEqual(node.setup, [
    { id: "c1", text: "Pick the review model", detail: "", link: "", done: false },
  ]);
});

test("derives readiness from the migrated checklist rather than inventing it", () => {
  const unfinished = migrated(
    v1Workflow({
      nodes: [
        v1Node("a", {
          checklist: [
            { id: "c1", text: "one", done: true },
            { id: "c2", text: "two", done: false },
          ],
        }),
      ],
    }),
  );
  assert.equal(firstNode(unfinished).readiness, "proposed");

  const finished = migrated(
    v1Workflow({
      nodes: [v1Node("a", { checklist: [{ id: "c1", text: "one", done: true }] })],
    }),
  );
  assert.equal(firstNode(finished).readiness, "configured");
});

test("never migrates a v1 card into a run-evidence readiness", () => {
  const document = migrated(
    v1Workflow({
      nodes: [
        v1Node("a", { checklist: [{ id: "c1", text: "one", done: true }] }),
        v1Node("b", { checklist: [] }),
      ],
    }),
  );
  for (const node of document.nodes as Record<string, unknown>[]) {
    assert.ok(
      node.readiness === "proposed" || node.readiness === "configured",
      `migration produced ${String(node.readiness)}`,
    );
  }
});

test("preserves v1 user text and position through migration", () => {
  const document = migrated(
    v1Workflow({
      nodes: [
        v1Node("a", {
          title: "<script>alert(1)</script>",
          instructions: "Do not execute: $(rm -rf /)",
          position: { x: 11, y: 22 },
          acceptanceCriteria: ["Cites every claim"],
        }),
      ],
    }),
  );
  const node = firstNode(document);
  assert.equal(node.title, "<script>alert(1)</script>");
  assert.equal(node.instructions, "Do not execute: $(rm -rf /)");
  assert.deepEqual(node.position, { x: 11, y: 22 });
  assert.deepEqual(node.acceptanceCriteria, ["Cites every claim"]);
});

test("a migrated v1 document passes current validation", () => {
  const document = migrated(
    v1Workflow({
      nodes: [
        v1Node("a", { type: "gate", checklist: [{ id: "c1", text: "one", done: true }] }),
        v1Node("b"),
      ],
      edges: [{ id: "e1", source: "a", target: "b", type: "requires", label: "", inferred: false }],
    }),
  );
  const result = validateWorkflow(document);
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : result.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
  );
});

test("the store migrates a v1 row on load without rewriting it", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-migrate-"));
  const path = join(dir, "canvas.sqlite");
  try {
    const legacy = v1Workflow({
      id: "legacy-1",
      revision: 4,
      nodes: [v1Node("a", { title: "Read the source", checklist: [] })],
    });

    // Write a v1 row the way an older build would have stored it.
    const seed = new DatabaseSync(path);
    seed.exec(
      "CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL)",
    );
    seed
      .prepare("INSERT INTO workflows (id, revision, document) VALUES (?, ?, ?)")
      .run("legacy-1", 4, JSON.stringify(legacy));
    seed.close();

    const store = openStore(path);
    const loaded = store.load("legacy-1");
    assert.equal(loaded?.schemaVersion, SCHEMA_VERSION);
    assert.equal(loaded?.revision, 4);
    assert.equal(loaded?.nodes[0]?.title, "Read the source");
    assert.equal(loaded?.nodes[0]?.readiness, "proposed");
    assert.deepEqual(loaded?.nodes[0]?.proposal, { agentOwns: [], youOwn: [] });
    store.close();

    // Loading must not have rewritten the stored row.
    const check = new DatabaseSync(path);
    const row = check
      .prepare("SELECT document FROM workflows WHERE id = ?")
      .get("legacy-1") as { document: string };
    check.close();
    assert.equal(JSON.parse(row.document).schemaVersion, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saving a migrated v1 workflow stores it at the current version", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-migrate-save-"));
  const path = join(dir, "canvas.sqlite");
  try {
    const legacy = v1Workflow({ id: "legacy-2", revision: 1, nodes: [v1Node("a")] });
    const seed = new DatabaseSync(path);
    seed.exec(
      "CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL)",
    );
    seed
      .prepare("INSERT INTO workflows (id, revision, document) VALUES (?, ?, ?)")
      .run("legacy-2", 1, JSON.stringify(legacy));
    seed.close();

    const store = openStore(path);
    const loaded = store.load("legacy-2")!;
    const saved = store.save(loaded, loaded.revision);
    assert.equal(saved.ok, true);

    const reloaded = store.load("legacy-2");
    assert.equal(reloaded?.schemaVersion, SCHEMA_VERSION);
    assert.equal(reloaded?.revision, 2);
    store.close();

    const check = new DatabaseSync(path);
    const row = check
      .prepare("SELECT document FROM workflows WHERE id = ?")
      .get("legacy-2") as { document: string };
    check.close();
    assert.equal(JSON.parse(row.document).schemaVersion, SCHEMA_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
