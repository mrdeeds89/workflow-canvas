import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyVersion,
  discardedFields,
  parseExternalWorkflow,
} from "../src/graph/compatibility.ts";
import { card, emptyWorkflow, setupTask, v1Node, v1Workflow } from "./fixtures.ts";

function codes(result: { ok: boolean; issues?: { code: string }[] }): string[] {
  return (result as { issues?: { code: string }[] }).issues?.map((i) => i.code) ?? [];
}

test("version classification gives a distinct, actionable code for each failure", () => {
  assert.equal(classifyVersion(42).ok, false);
  assert.equal((classifyVersion(42) as { issue: { code: string } }).issue.code, "not_an_object");
  assert.equal((classifyVersion({}) as { issue: { code: string } }).issue.code, "schema_version_missing");
  assert.equal(
    (classifyVersion({ schemaVersion: "5" }) as { issue: { code: string } }).issue.code,
    "schema_version_not_a_number",
  );
  assert.equal(
    (classifyVersion({ schemaVersion: 2.5 }) as { issue: { code: string } }).issue.code,
    "schema_version_fractional",
  );
  assert.equal(
    (classifyVersion({ schemaVersion: 0 }) as { issue: { code: string } }).issue.code,
    "schema_version_out_of_range",
  );
  assert.equal(
    (classifyVersion({ schemaVersion: -1 }) as { issue: { code: string } }).issue.code,
    "schema_version_out_of_range",
  );
  assert.equal(
    (classifyVersion({ schemaVersion: 999 }) as { issue: { code: string } }).issue.code,
    "schema_version_future",
  );
  assert.deepEqual(classifyVersion({ schemaVersion: 3 }), { ok: true, from: 3 });
});

test("a future or fractional version is refused before any migration", () => {
  for (const v of [999, 2.5, 0, -3]) {
    const result = parseExternalWorkflow(emptyWorkflow({ schemaVersion: v }));
    assert.equal(result.ok, false);
    assert.equal(result.discardedFields.length, 0);
  }
});

test("a valid current document passes unchanged", () => {
  const result = parseExternalWorkflow(emptyWorkflow({ nodes: [card("a")] }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.from, 5);
    assert.equal(result.to, 5);
    assert.equal(result.migrated, false);
    assert.deepEqual(result.discardedFields, []);
    assert.equal(result.value.nodes[0]?.id, "a");
  }
});

test("a v1 document migrates forward and loses no fields", () => {
  const input = v1Workflow({ nodes: [v1Node("a", { checklist: [{ id: "c1", text: "do", done: true }] })] });
  const result = parseExternalWorkflow(input);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.from, 1);
    assert.equal(result.migrated, true);
    assert.equal(result.value.schemaVersion, 5);
    // The checked v1 checklist became a configured setup list, not a dropped field.
    assert.deepEqual(result.discardedFields, []);
    assert.equal(result.value.nodes[0]?.setup[0]?.id, "c1");
    assert.equal(result.value.nodes[0]?.readiness, "configured");
  }
});

test("parsing never mutates the input document", () => {
  const input = v1Workflow({ nodes: [v1Node("a", { extra: "keep me out" })] });
  const snapshot = structuredClone(input);
  parseExternalWorkflow(input);
  assert.deepEqual(input, snapshot);
});

test("unknown fields are reported for cancel, not silently dropped, and do not fail a valid doc", () => {
  const input = emptyWorkflow({
    mysteryTop: 1,
    nodes: [card("a", { legacyFlag: true, position: { x: 0, y: 0, z: 9 } })],
    edges: [{ id: "e", source: "a", target: "a", type: "data", label: "", inferred: false, weight: 3 }],
  });
  const result = parseExternalWorkflow(input);
  // A self-loop data edge is allowed; the unknown keys are reported, not errors.
  assert.equal(result.ok, true);
  const fields = result.discardedFields.map((d) => `${d.path}:${d.field}`);
  assert.ok(fields.includes(":mysteryTop"));
  assert.ok(fields.includes("nodes[0]:legacyFlag"));
  assert.ok(fields.includes("nodes[0].position:z"));
  assert.ok(fields.includes("edges[0]:weight"));
});

test("discardedFields treats __proto__ as an ordinary unknown key", () => {
  const doc = JSON.parse('{"schemaVersion":5,"id":"wf","title":"t","description":"","brief":"","revision":1,"nodes":[],"edges":[],"groups":[],"sourceReferences":[],"__proto__x":1}');
  const fields = discardedFields(doc).map((d) => d.field);
  assert.ok(fields.includes("__proto__x"));
  // The real prototype was not polluted.
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("duplicate ids are rejected in every scope the file defines", () => {
  const dupSetup = parseExternalWorkflow(
    emptyWorkflow({ nodes: [card("a", { setup: [setupTask("s"), setupTask("s")] })] }),
  );
  assert.equal(dupSetup.ok, false);
  assert.ok(codes(dupSetup).includes("duplicate_id"));

  const dupPort = parseExternalWorkflow(
    emptyWorkflow({ nodes: [card("a", { inputs: [{ id: "p", name: "A" }, { id: "p", name: "B" }] })] }),
  );
  assert.equal(dupPort.ok, false);
  assert.ok(dupPort.issues.some((i) => i.path.includes("inputs")));

  const dupGroup = parseExternalWorkflow(
    emptyWorkflow({
      nodes: [card("a")],
      groups: [
        { id: "g", title: "G", memberIds: ["a"] },
        { id: "g", title: "H", memberIds: ["a"] },
      ],
    }),
  );
  assert.equal(dupGroup.ok, false);
  assert.ok(dupGroup.issues.some((i) => i.path.startsWith("groups")));

  const dupSource = parseExternalWorkflow(
    emptyWorkflow({
      sourceReferences: [
        { id: "s", documentId: "d", hash: "h", version: "1", section: "" },
        { id: "s", documentId: "d2", hash: "h2", version: "2", section: "" },
      ],
    }),
  );
  assert.equal(dupSource.ok, false);
  assert.ok(dupSource.issues.some((i) => i.path.startsWith("sourceReferences")));
});

test("a node listed twice in one group is rejected", () => {
  const result = parseExternalWorkflow(
    emptyWorkflow({ nodes: [card("a")], groups: [{ id: "g", title: "G", memberIds: ["a", "a"] }] }),
  );
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("duplicate_group_member"));
});

test("a dependency cycle is rejected but a revision cycle is allowed", () => {
  const dep = parseExternalWorkflow(
    emptyWorkflow({
      nodes: [card("a"), card("b")],
      edges: [
        { id: "e1", source: "a", target: "b", type: "requires", label: "", inferred: false },
        { id: "e2", source: "b", target: "a", type: "requires", label: "", inferred: false },
      ],
    }),
  );
  assert.equal(dep.ok, false);
  assert.ok(codes(dep).includes("dependency_cycle"));

  const rev = parseExternalWorkflow(
    emptyWorkflow({
      nodes: [card("a"), card("b")],
      edges: [
        { id: "e1", source: "a", target: "b", type: "revision", label: "", inferred: false },
        { id: "e2", source: "b", target: "a", type: "revision", label: "", inferred: false },
      ],
    }),
  );
  assert.equal(rev.ok, true);
});

test("hostile-looking text is preserved verbatim and never executed or stripped", () => {
  const title = "<script>alert(1)</script>";
  const brief = "javascript:alert(document.cookie)";
  const result = parseExternalWorkflow(emptyWorkflow({ brief, nodes: [card("a", { title, description: brief })] }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.brief, brief);
    assert.equal(result.value.nodes[0]?.title, title);
  }
});

test("a setup link that is a script URL is still rejected as unsafe", () => {
  const result = parseExternalWorkflow(
    emptyWorkflow({ nodes: [card("a", { setup: [setupTask("s", { link: "javascript:alert(1)" })] })] }),
  );
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("unsafe_link"));
});

test("duplicate node ids remain rejected through the external parser", () => {
  const result = parseExternalWorkflow(emptyWorkflow({ nodes: [card("a"), card("a")] }));
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("duplicate_id"));
});
