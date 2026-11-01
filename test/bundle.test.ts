import assert from "node:assert/strict";
import test from "node:test";
import { BUNDLE_FOOTER, RUN_BUNDLE_KIND, RUN_BUNDLE_VERSION, compileRunBundle } from "../src/graph/bundle.ts";
import { preflight } from "../src/graph/preflight.ts";
import { LOCAL_FILE_TARGET, type WorkflowDefinition } from "../src/graph/types.ts";
import { validateWorkflow } from "../src/graph/validate.ts";
import { card, emptyWorkflow } from "./fixtures.ts";

function ready(id: string, overrides: Record<string, unknown> = {}) {
  return card(id, {
    readiness: "configured",
    instructions: `Do ${id}.`,
    run: { executor: "runner", skills: [], maxRuntimeMinutes: 30 },
    ...overrides,
  });
}
function edge(id: string, source: string, target: string, type = "requires", label = "", inferred = false) {
  return { id, source, target, type, label, inferred };
}
function doc(nodes: unknown[], edges: unknown[] = []): WorkflowDefinition {
  const result = validateWorkflow(emptyWorkflow({ nodes, edges }));
  if (!result.ok) throw new Error(result.issues.map((i) => i.message).join("; "));
  return result.value;
}
const codes = (plan: ReturnType<typeof preflight>) => plan.issues.map((i) => i.code).sort();

test("a delivery on an artifact fed by a step is planned, with its producer", () => {
  const plan = preflight(
    doc(
      [ready("make"), card("out", { type: "artifact", readiness: "configured", deliverTo: LOCAL_FILE_TARGET })],
      [edge("e1", "make", "out", "data")],
    ),
  );
  assert.equal(plan.ok, true, JSON.stringify(plan.issues));
  assert.deepEqual(plan.deliveries, [{ cardId: "out", targetId: LOCAL_FILE_TARGET, produces: ["make"] }]);
});

test("a delivery on a non-artifact card is refused", () => {
  const plan = preflight(doc([ready("make", { deliverTo: LOCAL_FILE_TARGET })]));
  assert.ok(codes(plan).includes("delivery_on_non_artifact"));
});

test("a delivery artifact with nothing feeding it is refused", () => {
  const plan = preflight(doc([card("out", { type: "artifact", readiness: "configured", deliverTo: LOCAL_FILE_TARGET }), ready("x")]));
  assert.ok(codes(plan).includes("delivery_without_producer"));
});

test("a delivery to a target the harness does not offer is refused", () => {
  const plan = preflight(
    doc([ready("make"), card("out", { type: "artifact", readiness: "configured", deliverTo: "telegram:42" })], [edge("e1", "make", "out", "data")]),
    { executors: ["runner"], skills: [], deliveryTargets: ["telegram:7"] },
  );
  assert.ok(codes(plan).includes("delivery_target_unknown"));
});

test("local-file delivery is allowed even when the harness lists other targets", () => {
  const plan = preflight(
    doc([ready("make"), card("out", { type: "artifact", readiness: "configured", deliverTo: LOCAL_FILE_TARGET })], [edge("e1", "make", "out", "data")]),
    { executors: ["runner"], skills: [], deliveryTargets: ["telegram:7"] },
  );
  assert.equal(plan.ok, true, JSON.stringify(plan.issues));
});

test("the bundle keys every step, carries the footer, and attaches the delivery to its producer", () => {
  const def = doc(
    [ready("make"), card("out", { type: "artifact", readiness: "configured", deliverTo: LOCAL_FILE_TARGET })],
    [edge("e1", "make", "out", "data")],
  );
  const plan = preflight(def);
  const bundle = compileRunBundle(def, plan, "run-1", "digest-abc");
  assert.equal(bundle.kind, RUN_BUNDLE_KIND);
  assert.equal(bundle.version, RUN_BUNDLE_VERSION);
  assert.equal(bundle.keyPrefix, "wc:run-1:");
  assert.equal(bundle.digest, "digest-abc");
  const make = bundle.steps.find((s) => s.cardId === "make")!;
  assert.equal(make.key, "wc:run-1:make");
  assert.ok(make.body.includes(BUNDLE_FOOTER));
  assert.ok(make.body.includes("## Deliverable"), "a producer of a delivery is told to attach its result");
  assert.deepEqual(bundle.deliveries, [{ cardId: "out", targetId: LOCAL_FILE_TARGET, afterKeys: ["wc:run-1:make"], localFile: true }]);
});

test("an approval step gets no body and no assignee", () => {
  const def = doc(
    [ready("draft"), card("ok", { type: "approval", readiness: "configured" }), ready("send")],
    [edge("e1", "draft", "ok"), edge("e2", "ok", "send")],
  );
  const plan = preflight(def);
  const bundle = compileRunBundle(def, plan, "r", "d");
  const approval = bundle.steps.find((s) => s.cardId === "ok")!;
  assert.equal(approval.role, "approval");
  assert.equal(approval.body, "");
  assert.equal(approval.assignee, "");
  const send = bundle.steps.find((s) => s.cardId === "send")!;
  assert.deepEqual(send.waitsForKeys, ["wc:r:ok"]);
});

test("a decision card is told exactly which branch values to report", () => {
  const def = doc(
    [ready("choose"), ready("a"), ready("b")],
    [edge("e1", "choose", "a", "conditional", "pass"), edge("e2", "choose", "b", "conditional", "fail")],
  );
  const plan = preflight(def);
  const bundle = compileRunBundle(def, plan, "r", "d");
  const choose = bundle.steps.find((s) => s.cardId === "choose")!;
  assert.deepEqual(choose.decides.sort(), ["fail", "pass"]);
  assert.ok(choose.body.includes("`pass`") && choose.body.includes("`fail`"));
  assert.ok(choose.body.includes("metadata.branch"));
});

test("compiling a bundle from a failed plan throws", () => {
  const plan = preflight(doc([card("x", { type: "task", readiness: "proposed" })]));
  assert.equal(plan.ok, false);
  assert.throws(() => compileRunBundle(doc([card("x", { type: "task", readiness: "proposed" })]), plan, "r", "d"));
});
