import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflow } from "../src/graph/validate.ts";
import { card, emptyWorkflow } from "./fixtures.ts";

function taskNode(id: string, title = id) {
  return card(id, { title });
}

test("rejects an unsupported schema version", () => {
  const result = validateWorkflow({
    schemaVersion: 99,
    id: "wf-1",
    title: "Draft",
    description: "",
    revision: 1,
    nodes: [],
    edges: [],
    groups: [],
    sourceReferences: [],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.issues.some((issue) => issue.code === "unsupported_schema_version"),
    );
  }
});

test("rejects an edge whose endpoint is not a node", () => {
  const result = validateWorkflow(
    emptyWorkflow({
      edges: [
        {
          id: "e-1",
          source: "missing",
          target: "also-missing",
          type: "requires",
          label: "",
          inferred: false,
        },
      ],
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.code === "dangling_edge"));
  }
});

test("rejects a cycle of dependency edges", () => {
  const result = validateWorkflow(
    emptyWorkflow({
      nodes: [taskNode("a", "A"), taskNode("b", "B")],
      edges: [
        { id: "e-ab", source: "a", target: "b", type: "requires", label: "", inferred: false },
        { id: "e-ba", source: "b", target: "a", type: "requires", label: "", inferred: false },
      ],
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.code === "dependency_cycle"));
  }
});

test("allows a cycle made only of revision links", () => {
  const result = validateWorkflow(
    emptyWorkflow({
      nodes: [taskNode("a", "A"), taskNode("b", "B")],
      edges: [
        { id: "r-ab", source: "a", target: "b", type: "revision", label: "supersedes", inferred: false },
        { id: "r-ba", source: "b", target: "a", type: "revision", label: "revises", inferred: false },
      ],
    }),
  );

  assert.equal(result.ok, true);
});

test("rejects duplicate node ids", () => {
  const result = validateWorkflow(
    emptyWorkflow({
      nodes: [
        { id: "a", title: "A" },
        { id: "a", title: "A again" },
      ],
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.code === "duplicate_id"));
  }
});

test("rejects a node that is missing its required fields", () => {
  const result = validateWorkflow(
    emptyWorkflow({
      nodes: [{ id: "a", title: "A" }],
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.code === "invalid_node"));
  }
});

test("keeps user text as data and returns a normalized document", () => {
  const result = validateWorkflow(
    emptyWorkflow({
      title: "<script>alert(1)</script>",
      nodes: [
        card("a", {
          title: "Read the source",
          position: { x: 10, y: 20 },
          owner: "human",
          instructions: "Do not execute this: ${process}",
          runCommand: "rm -rf /",
        }),
      ],
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.title, "<script>alert(1)</script>");
    assert.equal(result.value.nodes[0]?.instructions, "Do not execute this: ${process}");
    assert.equal("runCommand" in result.value.nodes[0]!, false);
  }
});
