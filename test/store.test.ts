import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore } from "../src/graph/store.ts";
import type { WorkflowNode } from "../src/graph/types.ts";
import { card } from "./fixtures.ts";

function taskNode(id: string, title: string) {
  return card(id, { title, owner: "human", position: { x: 12, y: 24 } });
}

test("reloads a saved workflow after the store is reopened", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-"));
  const path = join(dir, "canvas.sqlite");
  try {
    const store = openStore(path);
    const created = store.create({ title: "Research" });
    created.nodes.push(taskNode("read", "Read the source") as unknown as WorkflowNode);
    const saved = store.save(created, created.revision);
    assert.equal(saved.ok, true);
    if (saved.ok) assert.equal(saved.value.revision, 2);
    store.close();

    const again = openStore(path);
    const loaded = again.load(created.id);
    assert.equal(loaded?.title, "Research");
    assert.equal(loaded?.nodes[0]?.title, "Read the source");
    assert.equal(loaded?.nodes[0]?.position.x, 12);
    assert.equal(loaded?.revision, 2);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a stale revision and leaves the stored graph unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-"));
  const path = join(dir, "canvas.sqlite");
  try {
    const store = openStore(path);
    const created = store.create({ title: "Research" });
    const saved = store.save(created, created.revision);
    assert.equal(saved.ok, true);

    const stale = store.save(created, created.revision);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "conflict");

    const loaded = store.load(created.id);
    assert.equal(loaded?.revision, 2);
    assert.equal(loaded?.title, "Research");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects an invalid graph and leaves the stored graph unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-"));
  const path = join(dir, "canvas.sqlite");
  try {
    const store = openStore(path);
    const created = store.create({ title: "Research" });
    const broken = {
      ...created,
      edges: [
        {
          id: "e-1",
          source: "missing",
          target: "also-missing",
          type: "requires" as const,
          label: "",
          inferred: false,
        },
      ],
    };
    const saved = store.save(broken, created.revision);
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.code, "invalid");

    const loaded = store.load(created.id);
    assert.equal(loaded?.revision, 1);
    assert.equal(loaded?.edges.length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
