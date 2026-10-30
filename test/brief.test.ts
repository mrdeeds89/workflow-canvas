import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateToCurrent } from "../src/graph/migrate.ts";
import { openStore } from "../src/graph/store.ts";
import { createApp } from "../src/http/server.ts";
import { emptyWorkflow } from "./fixtures.ts";

/** Markup, headings and uneven whitespace must survive as text, not as structure. */
const VERBATIM =
  "Purpose\n\n<script>alert(1)</script>\n\nInputs required\n\n  a topic  \n";

const HEADINGS = [
  "Purpose",
  "Inputs required",
  "Expected outputs",
  "Success criteria",
  "Limits",
  "Open questions",
];

function schema2Document(brief?: string) {
  return {
    schemaVersion: 2,
    id: "wf-old",
    title: "Legacy map",
    description: "keep this description",
    revision: 4,
    nodes: [],
    edges: [],
    groups: [],
    sourceReferences: [],
    ...(brief === undefined ? {} : { brief }),
  };
}

test("stores a workflow brief verbatim and does not parse its headings", () => {
  const result = validateBrief(VERBATIM);
  assert.equal(result.ok, true, issuesOf(result));
  if (!result.ok) return;
  assert.equal(result.value.brief, VERBATIM);
  assert.equal(result.value.schemaVersion, 3);
  assert.equal("purpose" in result.value, false);
  assert.equal("inputs" in result.value, false);
  assert.equal("runCommand" in result.value, false);
});

test("accepts an empty brief and a brief that ignores the suggested headings", () => {
  for (const brief of ["", "Just one sentence, no headings."]) {
    const result = validateBrief(brief);
    assert.equal(result.ok, true, issuesOf(result));
    if (result.ok) assert.equal(result.value.brief, brief);
  }
});

test("refuses a brief that is not text or is longer than 20000 characters", () => {
  for (const brief of [null, 1, { Purpose: "no" }, ["Purpose"]]) {
    const result = validateBrief(brief);
    assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(brief)}`);
    if (!result.ok) {
      assert.ok(result.issues.some((issue) => issue.path === "brief"));
    }
  }
  const tooLong = validateBrief("x".repeat(20_001));
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.ok(tooLong.issues.some((issue) => issue.path === "brief"));
  const atLimit = validateBrief("x".repeat(20_000));
  assert.equal(atLimit.ok, true, issuesOf(atLimit));
});

test("migrates a schema 2 workflow to an empty brief without inventing headings", () => {
  const result = migrateToCurrent(schema2Document());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.migrated, true);
  assert.equal(result.from, 2);
  assert.equal(result.to, 3);
  const document = result.value as Record<string, unknown>;
  assert.equal(document.schemaVersion, 3);
  assert.equal(document.brief, "");
  assert.equal(document.description, "keep this description");
  const stored = JSON.stringify(document);
  for (const heading of HEADINGS) {
    assert.equal(stored.includes(heading), false, `migration invented heading ${heading}`);
  }

  const validated = validateBriefFrom(document);
  assert.equal(validated.ok, true, issuesOf(validated));
});

test("migration keeps an existing brief string exactly and does not rewrite it", () => {
  const result = migrateToCurrent(schema2Document(VERBATIM));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const document = result.value as Record<string, unknown>;
  assert.equal(document.schemaVersion, 3);
  assert.equal(document.brief, VERBATIM);
});

test("loading a stored schema 2 row returns an empty brief and does not rewrite the row", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-brief-v2-"));
  const path = join(dir, "canvas.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(
      "CREATE TABLE workflows (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL)",
    );
    seed
      .prepare("INSERT INTO workflows (id, revision, document) VALUES (?, ?, ?)")
      .run("wf-old", 4, JSON.stringify(schema2Document()));
    seed.close();

    const store = openStore(path);
    const loaded = store.load("wf-old");
    assert.equal(loaded?.brief, "");
    assert.equal(loaded?.schemaVersion, 3);
    assert.equal(loaded?.title, "Legacy map");
    store.close();

    const check = new DatabaseSync(path);
    const row = check.prepare("SELECT document FROM workflows WHERE id = ?").get("wf-old") as {
      document: string;
    };
    check.close();
    const stored = JSON.parse(row.document) as { schemaVersion: number; brief?: unknown };
    assert.equal(stored.schemaVersion, 2);
    assert.equal("brief" in stored, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a saved brief round-trips through the store and a copy keeps it", () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-brief-store-"));
  try {
    const store = openStore(join(dir, "canvas.sqlite"));
    const created = store.create({ title: "Research" });
    assert.equal(created.brief, "");
    const saved = store.save({ ...created, brief: VERBATIM }, created.revision);
    assert.equal(saved.ok, true, saved.ok ? "" : saved.code);
    if (!saved.ok) return;
    assert.equal(saved.value.brief, VERBATIM);
    assert.equal(store.load(created.id)?.brief, VERBATIM);

    const copy = store.duplicateWorkflow(created.id);
    assert.equal(copy?.brief, VERBATIM);
    assert.equal(store.load(created.id)?.brief, VERBATIM);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the API returns the brief as inert text and a stale save does not replace it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-brief-http-"));
  const store = openStore(join(dir, "canvas.sqlite"));
  const server = createApp({ store });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const createdResponse = await fetch(`${base}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Research" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as Record<string, unknown>;
    assert.equal(created.brief, "");

    const savedResponse = await fetch(`${base}/api/workflows/${created.id as string}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...created, brief: VERBATIM }),
    });
    assert.equal(savedResponse.status, 200);
    const saved = (await savedResponse.json()) as { brief: string; revision: number };
    assert.equal(saved.brief, VERBATIM);

    const loadedResponse = await fetch(`${base}/api/workflows/${created.id as string}`);
    const loaded = (await loadedResponse.json()) as { brief: string; revision: number };
    assert.equal(loaded.brief, VERBATIM);

    const stale = await fetch(`${base}/api/workflows/${created.id as string}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...created, brief: "replaced by a stale editor" }),
    });
    assert.equal(stale.status, 409);
    const afterConflict = (await (await fetch(`${base}/api/workflows/${created.id as string}`)).json()) as {
      brief: string;
    };
    assert.equal(afterConflict.brief, VERBATIM);

    const refused = await fetch(`${base}/api/workflows/${created.id as string}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...saved, brief: { Purpose: "parsed" } }),
    });
    assert.equal(refused.status, 422);
    const afterRefusal = (await (await fetch(`${base}/api/workflows/${created.id as string}`)).json()) as {
      brief: string;
    };
    assert.equal(afterRefusal.brief, VERBATIM);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function validateBrief(brief: unknown) {
  return validateWorkflow(emptyWorkflow({ schemaVersion: 3, brief }));
}

function validateBriefFrom(document: Record<string, unknown>) {
  return validateWorkflow(document);
}

function issuesOf(result: { ok: boolean; issues?: { path: string; message: string }[] }): string {
  return result.ok || !result.issues ? "" : result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

// Imported at the bottom of the helpers' use so a missing export fails the test file loudly.
import { validateWorkflow } from "../src/graph/validate.ts";
