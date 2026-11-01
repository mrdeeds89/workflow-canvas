import { LOCAL_FILE_TARGET, type NodeKind, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode } from "./types.ts";

/**
 * "What would run": a pure check of a workflow against the run rules in
 * docs/RUN-PLAN.md. Shared by the server (authoritative, on a run request)
 * and the browser (instant feedback). It starts nothing and talks to nothing.
 *
 * Rules, in short:
 * - task, agent and integration cards run; approval cards stop the run until
 *   Dom approves; artifact cards pass through; note cards are ignored.
 * - requires, data and conditional arrows are dependencies; revision arrows
 *   are explanatory and ignored.
 * - a conditional arrow is one branch of its source card's decision. Cards
 *   behind an untaken branch are never created. A card that several branches
 *   lead back into (a join) exists whichever of those branches is taken, and
 *   waits only for the parents that exist.
 * - stages break at approvals and at branch decisions. Everything in one
 *   stage can be handed to Hermes at once; Kanban orders it by parent links.
 */

export type PreflightIssue = {
  code: string;
  message: string;
  cardId?: string;
  edgeId?: string;
};

/** This step exists only if `decisionCardId` reports one of `branches`. */
export type BranchRequirement = { decisionCardId: string; branches: string[] };

export type PlannedStep = {
  cardId: string;
  title: string;
  role: "run" | "approval";
  stage: number;
  /** Running or approval cards this step waits for, looking through artifacts. */
  waitsFor: string[];
  /** Branches that must be chosen for this step to exist. */
  branches: BranchRequirement[];
  /** For a decision card: the branch values its worker must report. */
  decides: string[];
  executor: string;
  skills: string[];
  maxRuntimeMinutes: number;
};

export type PlannedStage = {
  index: number;
  /** Approval cards that must be approved before this stage is created. */
  afterApprovals: string[];
  /** Decision cards whose branch must be reported before this stage is created. */
  afterDecisions: string[];
  steps: PlannedStep[];
};

export type Allowlist = {
  executors: readonly string[];
  skills: readonly string[];
  /** Delivery target ids the connected harness reported; omit when none is connected. */
  deliveryTargets?: readonly string[];
};

/**
 * A result delivery a run will perform: an artifact card's output to a target
 * id. `produces` is the run/approval cards whose output reaches this artifact
 * (through other artifacts), i.e. what must finish before the delivery.
 */
export type PlannedDelivery = { cardId: string; targetId: string; produces: string[] };

export type Preflight = {
  ok: boolean;
  issues: PreflightIssue[];
  /** Not blocking. Explains what is ignored or not checked. */
  notices: string[];
  stages: PlannedStage[];
  /** Deliveries this run would perform, one per artifact card with a target. */
  deliveries: PlannedDelivery[];
};

const RUNS: ReadonlySet<NodeKind> = new Set(["task", "agent", "integration"]);
const DEPENDENCY_EDGES = new Set(["requires", "data", "conditional"]);

function roleOf(card: WorkflowNode): "run" | "approval" | "artifact" | "note" {
  if (RUNS.has(card.type)) return "run";
  if (card.type === "approval") return "approval";
  return card.type === "artifact" ? "artifact" : "note";
}

function name(card: WorkflowNode | undefined): string {
  const title = card?.title.trim() ?? "";
  return title === "" ? "Untitled card" : `"${title}"`;
}

/**
 * Check a workflow. `allowlist` is the harness's list of profiles and skills a
 * run may use. Without one (no conductor configured), names are checked for
 * presence only and a notice says so.
 */
export function preflight(definition: WorkflowDefinition, allowlist: Allowlist | null = null): Preflight {
  const issues: PreflightIssue[] = [];
  const notices: string[] = [];
  const deliveries: PlannedDelivery[] = [];
  const cards = new Map(definition.nodes.map((card) => [card.id, card]));

  // Only edges between cards that take part. Notes never take part.
  const participates = (id: string) => {
    const card = cards.get(id);
    return card !== undefined && roleOf(card) !== "note";
  };
  const deps: WorkflowEdge[] = [];
  let ignoredRevision = 0;
  let ignoredNoteEdges = 0;
  for (const edge of definition.edges) {
    if (!DEPENDENCY_EDGES.has(edge.type)) {
      ignoredRevision += 1;
      continue;
    }
    if (!participates(edge.source) || !participates(edge.target)) {
      ignoredNoteEdges += 1;
      continue;
    }
    deps.push(edge);
  }
  const incoming = new Map<string, WorkflowEdge[]>();
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const card of definition.nodes) {
    incoming.set(card.id, []);
    outgoing.set(card.id, []);
  }
  for (const edge of deps) {
    incoming.get(edge.target)!.push(edge);
    outgoing.get(edge.source)!.push(edge);
  }

  const active = definition.nodes.filter((card) => roleOf(card) !== "note");
  const runnable = active.filter((card) => roleOf(card) === "run");
  if (runnable.length === 0) {
    issues.push({ code: "nothing_to_run", message: "There is no task, agent or integration card to run." });
  }

  // Card-level checks.
  for (const card of active) {
    const role = roleOf(card);
    if (card.inferred) {
      issues.push({
        code: "card_inferred",
        cardId: card.id,
        message: `${name(card)} is labelled Inferred. A person has to confirm it before its text becomes an agent's instructions.`,
      });
    }
    if (card.deliverTo !== "") {
      if (role !== "artifact") {
        issues.push({
          code: "delivery_on_non_artifact",
          cardId: card.id,
          message: `${name(card)} has a delivery target, but only an artifact card can deliver a result. Move the delivery to an artifact card.`,
        });
      } else if (incoming.get(card.id)!.length === 0) {
        issues.push({
          code: "delivery_without_producer",
          cardId: card.id,
          message: `${name(card)} delivers a result but nothing feeds into it. Connect the step that produces this output.`,
        });
      } else if (allowlist?.deliveryTargets && card.deliverTo !== LOCAL_FILE_TARGET && !allowlist.deliveryTargets.includes(card.deliverTo)) {
        issues.push({
          code: "delivery_target_unknown",
          cardId: card.id,
          message: `${name(card)} delivers to a target the connected Hermes no longer offers. Pick the delivery again.`,
        });
      } else {
        deliveries.push({ cardId: card.id, targetId: card.deliverTo, produces: [] });
      }
    }
    if (role === "artifact") continue;
    if (card.readiness !== "configured") {
      issues.push({
        code: "card_not_configured",
        cardId: card.id,
        message:
          card.readiness === "proposed"
            ? `${name(card)} is still proposed. Approve it and finish its setup checks.`
            : `${name(card)} has unfinished setup checks.`,
      });
    }
    if (role !== "run") continue;
    if (card.instructions.trim() === "" && card.description.trim() === "") {
      issues.push({
        code: "instructions_missing",
        cardId: card.id,
        message: `${name(card)} has no description or instructions, so the agent would get nothing to do.`,
      });
    }
    if (card.run.executor === "") {
      issues.push({ code: "executor_missing", cardId: card.id, message: `${name(card)} does not say which Hermes profile does it.` });
    } else if (allowlist && !allowlist.executors.includes(card.run.executor)) {
      issues.push({
        code: "executor_not_allowed",
        cardId: card.id,
        message: `${name(card)} names profile "${card.run.executor}", which this harness does not allow for runs.`,
      });
    }
    if (allowlist) {
      for (const skill of card.run.skills) {
        if (!allowlist.skills.includes(skill)) {
          issues.push({
            code: "skill_not_allowed",
            cardId: card.id,
            message: `${name(card)} loads skill "${skill}", which this harness does not allow for runs.`,
          });
        }
      }
    }
  }

  for (const edge of deps) {
    if (edge.inferred) {
      issues.push({
        code: "edge_inferred",
        edgeId: edge.id,
        message: `The arrow from ${name(cards.get(edge.source))} to ${name(cards.get(edge.target))} is labelled Inferred. Confirm it first.`,
      });
    }
  }

  // Branch decisions: the source of a conditional arrow.
  const decides = new Map<string, string[]>();
  for (const card of active) {
    const branches = outgoing.get(card.id)!.filter((edge) => edge.type === "conditional");
    if (branches.length === 0) continue;
    if (roleOf(card) !== "run") {
      issues.push({
        code: "branch_source_not_runnable",
        cardId: card.id,
        message: `${name(card)} has a conditional arrow, but only a task, agent or integration card can choose a branch.`,
      });
      continue;
    }
    const labels = branches.map((edge) => edge.label.trim());
    const distinct = [...new Set(labels)];
    if (distinct.length !== labels.length) {
      issues.push({
        code: "branch_duplicate_label",
        cardId: card.id,
        message: `${name(card)} has two conditional arrows with the same condition. Each branch needs its own.`,
      });
    }
    if (distinct.length < 2) {
      issues.push({
        code: "branch_needs_two",
        cardId: card.id,
        message: `${name(card)} has only one conditional arrow. A choice needs at least two, for example "pass" and "fail".`,
      });
    }
    decides.set(card.id, distinct);
  }

  // Order the cards. The validator already refuses requires-cycles; data and
  // conditional arrows could still form one, which a run cannot have.
  const order = topologicalOrder(active.map((card) => card.id), deps);
  if (order === null) {
    issues.push({ code: "dependency_cycle", message: "The arrows that carry work forward form a loop, so no step could start." });
    return { ok: false, issues, notices, stages: [], deliveries };
  }

  // Stage, branch requirements, and nearest running/approval ancestors.
  const stage = new Map<string, number>();
  const branches = new Map<string, Map<string, Set<string>>>();
  const waitsFor = new Map<string, Set<string>>();
  const afterApprovals = new Map<string, Set<string>>();
  const afterDecisions = new Map<string, Set<string>>();
  for (const id of order) {
    let level = 0;
    const parents = new Set<string>();
    // What each incoming arrow needs: the parent's own needs, plus this branch.
    const perEdge: Map<string, Set<string>>[] = [];
    for (const edge of incoming.get(id)!) {
      const parent = cards.get(edge.source)!;
      const parentRole = roleOf(parent);
      const bump = parentRole === "approval" || edge.type === "conditional" ? 1 : 0;
      level = Math.max(level, (stage.get(parent.id) ?? 0) + bump);
      const needs = new Map<string, Set<string>>();
      for (const [decision, values] of branches.get(parent.id) ?? []) needs.set(decision, new Set(values));
      if (edge.type === "conditional") needs.set(parent.id, new Set([edge.label.trim()]));
      perEdge.push(needs);
      if (parentRole === "artifact") (waitsFor.get(parent.id) ?? new Set()).forEach((p) => parents.add(p));
      else parents.add(parent.id);
    }
    // A card exists if any of its arrows can exist. So a decision constrains it
    // only when every arrow is constrained by that decision, and then any of
    // their values will do. If that covers every branch, it is no constraint.
    const required = new Map<string, Set<string>>();
    if (perEdge.length > 0) {
      for (const decision of perEdge[0]!.keys()) {
        if (!perEdge.every((needs) => needs.has(decision))) continue;
        const allowed = new Set<string>();
        perEdge.forEach((needs) => needs.get(decision)!.forEach((value) => allowed.add(value)));
        const all = decides.get(decision) ?? [];
        if (all.length > 0 && all.every((value) => allowed.has(value))) continue;
        required.set(decision, allowed);
      }
    }
    stage.set(id, level);
    branches.set(id, required);
    waitsFor.set(id, parents);
  }
  // Now that upstream run/approval ancestors are known, tell each delivery
  // which steps produce the output it sends.
  for (const delivery of deliveries) {
    delivery.produces = [...(waitsFor.get(delivery.cardId) ?? new Set<string>())];
  }
  // Which gates open each stage.
  // Looks through artifact cards, like waitsFor does.
  for (const id of order) {
    const level = stage.get(id)!;
    for (const parent of waitsFor.get(id)!) {
      if (roleOf(cards.get(parent)!) === "approval" && stage.get(parent)! + 1 === level) {
        add(afterApprovals, String(level), parent);
      }
    }
    for (const decision of branches.get(id)!.keys()) {
      if (stage.get(decision)! + 1 === level) add(afterDecisions, String(level), decision);
    }
  }

  const stagesByIndex = new Map<number, PlannedStep[]>();
  for (const id of order) {
    const card = cards.get(id)!;
    const role = roleOf(card);
    if (role !== "run" && role !== "approval") continue;
    const step: PlannedStep = {
      cardId: id,
      title: card.title,
      role,
      stage: stage.get(id)!,
      waitsFor: [...waitsFor.get(id)!],
      branches: [...branches.get(id)!].map(([decisionCardId, values]) => ({ decisionCardId, branches: [...values] })),
      decides: decides.get(id) ?? [],
      executor: role === "run" ? card.run.executor : "",
      skills: role === "run" ? [...card.run.skills] : [],
      maxRuntimeMinutes: card.run.maxRuntimeMinutes,
    };
    const list = stagesByIndex.get(step.stage) ?? [];
    list.push(step);
    stagesByIndex.set(step.stage, list);
  }
  const stages: PlannedStage[] = [...stagesByIndex.keys()]
    .sort((a, b) => a - b)
    .map((index) => ({
      index,
      afterApprovals: [...(afterApprovals.get(String(index)) ?? [])],
      afterDecisions: [...(afterDecisions.get(String(index)) ?? [])],
      steps: stagesByIndex.get(index)!,
    }));

  const notes = definition.nodes.filter((card) => roleOf(card) === "note").length;
  const artifacts = definition.nodes.filter((card) => roleOf(card) === "artifact").length;
  if (notes > 0) notices.push(`${notes} note ${notes === 1 ? "card is" : "cards are"} context only and will not run.`);
  if (artifacts > 0) notices.push(`${artifacts} artifact ${artifacts === 1 ? "card marks" : "cards mark"} an output. Artifacts do not run.`);
  if (ignoredRevision > 0) notices.push(`${ignoredRevision} revision ${ignoredRevision === 1 ? "arrow is" : "arrows are"} explanatory and ignored.`);
  if (ignoredNoteEdges > 0) notices.push(`${ignoredNoteEdges} ${ignoredNoteEdges === 1 ? "arrow touches" : "arrows touch"} a note and ${ignoredNoteEdges === 1 ? "is" : "are"} ignored.`);
  for (const card of active) {
    if (roleOf(card) === "approval" && outgoing.get(card.id)!.length === 0) {
      notices.push(`Approval ${name(card)} has nothing after it, so approving it would only end the run.`);
    }
  }
  if (!allowlist) {
    notices.push("No harness conductor is configured, so profile and skill names are not checked against a harness allowlist.");
  }

  return { ok: issues.length === 0, issues, notices, stages, deliveries };
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

/** Kahn's algorithm, keeping the document's card order among equals. Null on a cycle. */
function topologicalOrder(ids: string[], edges: WorkflowEdge[]): string[] | null {
  const indegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    next.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const rank = new Map(ids.map((id, index) => [id, index]));
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
    const id = ready.shift()!;
    order.push(id);
    for (const target of next.get(id)!) {
      const left = indegree.get(target)! - 1;
      indegree.set(target, left);
      if (left === 0) ready.push(target);
    }
  }
  return order.length === ids.length ? order : null;
}
