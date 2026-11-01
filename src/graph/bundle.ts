import type { BranchRequirement, Preflight } from "./preflight.ts";
import { LOCAL_FILE_TARGET, type WorkflowDefinition, type WorkflowNode } from "./types.ts";

/**
 * The run bundle: a frozen, self-contained description of what a conductor on
 * the Hermes machine should create, stage by stage, for one run of one
 * revision. It is produced from a definition and its authoritative preflight
 * plan, and nothing else. It is pure and Node-free so the browser can show it
 * and tests can check it without a database.
 *
 * The bundle never starts anything. Canvas hands it out; the conductor reads
 * it and creates Kanban tasks. Card text reaches an agent only through a
 * step's `body` here, and only for cards that passed preflight.
 *
 * Design rules carried into the bundle (docs/RUN-PLAN.md, docs/R2-PLAN.md):
 * - Approval steps are markers. The conductor does not create a task for them;
 *   it refuses to create the next stage until Canvas records a human approval.
 * - A delivery is performed by the conductor, never by an agent. The bundle
 *   only records which output goes to which target id; the real chat id stays
 *   on the Hermes side.
 * - Every step body ends with a fixed footer stating the step is part of a
 *   Workflow Canvas run and is not authorization to trade or move money.
 */

export const RUN_BUNDLE_KIND = "workflow-canvas.run-bundle";
export const RUN_BUNDLE_VERSION = 1 as const;

/** Fixed footer appended to every step body. Never changes per card. */
export const BUNDLE_FOOTER =
  "— This step is one part of a Workflow Canvas run. It is a description of work, " +
  "not authorization to trade, move money, or take any irreversible action. " +
  "Do only what this step describes. If it is unclear or asks for any of those, stop and report instead.";

export type BundleStep = {
  /** Idempotency key and Kanban correlation: `wc:<runId>:<cardId>`. */
  key: string;
  cardId: string;
  title: string;
  role: "run" | "approval";
  stage: number;
  /** Hermes profile for a run step; "" for an approval step (no task created). */
  assignee: string;
  skills: string[];
  maxRuntimeMinutes: number;
  /** Keys of steps this one waits for (parent links for Kanban). */
  waitsForKeys: string[];
  /** This step exists only if these branch choices are made. */
  branches: BranchRequirement[];
  /** For a decision card: the branch values the worker must report. */
  decides: string[];
  /** Composed instructions plus the fixed footer. Empty for approval steps. */
  body: string;
};

export type BundleDelivery = {
  cardId: string;
  targetId: string;
  /** Keys of the steps whose completion releases this delivery. */
  afterKeys: string[];
  /** True for the built-in local-file target (conductor writes a file, no send). */
  localFile: boolean;
};

export type RunBundle = {
  kind: typeof RUN_BUNDLE_KIND;
  version: typeof RUN_BUNDLE_VERSION;
  runId: string;
  workflowId: string;
  workflowTitle: string;
  revision: number;
  digest: string;
  /** `wc:<runId>:` — every step key starts with this. */
  keyPrefix: string;
  stageCount: number;
  steps: BundleStep[];
  deliveries: BundleDelivery[];
};

function keyFor(runId: string, cardId: string): string {
  return `wc:${runId}:${cardId}`;
}

function composeBody(card: WorkflowNode, decides: string[], feedsDelivery: boolean): string {
  const parts: string[] = [];
  parts.push(`# ${card.title.trim() || "Untitled step"}`);
  if (card.description.trim() !== "") parts.push(card.description.trim());
  if (card.instructions.trim() !== "") parts.push(`## Instructions\n${card.instructions.trim()}`);
  if (card.inputs.length > 0) {
    parts.push(`## Inputs\n${card.inputs.map((p) => `- ${p.name}`).join("\n")}`);
  }
  if (card.outputs.length > 0) {
    parts.push(`## Outputs\n${card.outputs.map((p) => `- ${p.name}`).join("\n")}`);
  }
  if (card.acceptanceCriteria.length > 0) {
    parts.push(`## Acceptance criteria\n${card.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`);
  }
  if (decides.length > 0) {
    parts.push(
      `## Report a branch\nThis step chooses a path. Report exactly one of these values as \`metadata.branch\`: ${decides
        .map((v) => `\`${v}\``)
        .join(", ")}. Report nothing else as the branch.`,
    );
  }
  if (feedsDelivery) {
    parts.push(
      "## Deliverable\nWrite this step's result to a file in your task workspace and attach it. Canvas's conductor, not you, sends it on. Do not message, post, or send it anywhere yourself.",
    );
  }
  parts.push(BUNDLE_FOOTER);
  return parts.join("\n\n");
}

/**
 * Compile a bundle. Throws if the plan did not pass preflight: a bundle is only
 * ever made from a clean plan, so a caller that reaches here with `ok: false`
 * has a bug.
 */
export function compileRunBundle(definition: WorkflowDefinition, plan: Preflight, runId: string, digest: string): RunBundle {
  if (!plan.ok) {
    throw new Error("Refusing to compile a run bundle from a plan that did not pass preflight.");
  }
  const cards = new Map(definition.nodes.map((card) => [card.id, card]));
  const keyPrefix = `wc:${runId}:`;

  // Cards whose output feeds a delivery (so their body asks for an attachment).
  const feedsDelivery = new Set<string>();
  for (const delivery of plan.deliveries) {
    for (const producerId of delivery.produces) feedsDelivery.add(producerId);
  }

  const steps: BundleStep[] = [];
  for (const stage of plan.stages) {
    for (const step of stage.steps) {
      const card = cards.get(step.cardId);
      if (!card) continue;
      steps.push({
        key: keyFor(runId, step.cardId),
        cardId: step.cardId,
        title: step.title,
        role: step.role,
        stage: step.stage,
        assignee: step.executor,
        skills: step.skills,
        maxRuntimeMinutes: step.maxRuntimeMinutes,
        waitsForKeys: step.waitsFor.map((parentId) => keyFor(runId, parentId)),
        branches: step.branches,
        decides: step.decides,
        body: step.role === "approval" ? "" : composeBody(card, step.decides, feedsDelivery.has(step.cardId)),
      });
    }
  }

  const deliveries: BundleDelivery[] = plan.deliveries.map((delivery) => ({
    cardId: delivery.cardId,
    targetId: delivery.targetId,
    afterKeys: delivery.produces.map((producerId) => keyFor(runId, producerId)),
    localFile: delivery.targetId === LOCAL_FILE_TARGET,
  }));

  return {
    kind: RUN_BUNDLE_KIND,
    version: RUN_BUNDLE_VERSION,
    runId,
    workflowId: definition.id,
    workflowTitle: definition.title,
    revision: definition.revision,
    digest,
    keyPrefix,
    stageCount: plan.stages.length,
    steps,
    deliveries,
  };
}
