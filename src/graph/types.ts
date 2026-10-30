export const SCHEMA_VERSION = 2;

/** Versions this build can read. Older ones are migrated forward on load. */
export const READABLE_SCHEMA_VERSIONS = [1, 2] as const;

export type Owner = "human" | "agent" | "unassigned";

export type NodeKind = "task" | "agent" | "integration" | "approval" | "artifact" | "note";

export type EdgeKind = "requires" | "data" | "conditional" | "revision";

/**
 * Readiness ladder for a card.
 *
 * `proposed`        drafted, not yet approved.
 * `not_configured`  approved, but setup is unfinished.
 * `configured`      approved, every setup task checked.
 * `tested`          a real run produced passing evidence.
 * `operational`     running in earnest.
 *
 * `tested` and `operational` describe run evidence, not editing. This is a
 * design-time editor with no execution, so it cannot produce that evidence
 * and must refuse to assert it. See DESIGN_TIME_READINESS.
 */
export type Readiness = "proposed" | "not_configured" | "configured" | "tested" | "operational";

/** Readiness values a design-time edit may set. */
export const DESIGN_TIME_READINESS: readonly Readiness[] = [
  "proposed",
  "not_configured",
  "configured",
];

/** Readiness values that may only come from observed run evidence. */
export const RUN_EVIDENCE_READINESS: readonly Readiness[] = ["tested", "operational"];

/** One item in a card's setup checklist. */
export type SetupTask = {
  id: string;
  /** Short imperative label, e.g. "Pick the review model". */
  text: string;
  /** Why it matters, shown under the label. May be empty. */
  detail: string;
  /** Empty, or an absolute http(s) URL. Never a script or data URL. */
  link: string;
  done: boolean;
};

/**
 * The split of work on a card: what the agent is expected to do, and what the
 * human is expected to do. Both lists are plain text, one responsibility per
 * entry. Neither list is executable.
 */
export type Proposal = {
  agentOwns: string[];
  youOwn: string[];
};

export type Port = {
  id: string;
  name: string;
};

export type WorkflowNode = {
  id: string;
  title: string;
  description: string;
  type: NodeKind;
  position: { x: number; y: number };
  /** Primary responsibility for the step as a whole. */
  owner: Owner;
  instructions: string;
  /** Free-form JSON text describing the card's intent. Stored, never executed. */
  spec: string;
  readiness: Readiness;
  proposal: Proposal;
  setup: SetupTask[];
  inputs: Port[];
  outputs: Port[];
  acceptanceCriteria: string[];
  inferred: boolean;
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  type: EdgeKind;
  label: string;
  inferred: boolean;
};

export type WorkflowGroup = {
  id: string;
  title: string;
  memberIds: string[];
};

export type SourceReference = {
  id: string;
  documentId: string;
  hash: string;
  version: string;
  section: string;
};

export type WorkflowDefinition = {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  title: string;
  description: string;
  revision: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: WorkflowGroup[];
  sourceReferences: SourceReference[];
};

export type ValidationIssue = {
  code: string;
  path: string;
  message: string;
};

export type ValidationResult =
  | { ok: true; value: WorkflowDefinition }
  | { ok: false; issues: ValidationIssue[] };

/** Setup completion for a card, used for progress display such as "1/1". */
export function setupProgress(node: WorkflowNode): { done: number; total: number } {
  return {
    done: node.setup.filter((task) => task.done).length,
    total: node.setup.length,
  };
}

/** True when every setup task is checked. Vacuously true when there are none. */
export function setupComplete(node: WorkflowNode): boolean {
  return node.setup.every((task) => task.done);
}

/**
 * Readiness the server stores for a design-time card.
 *
 * `configured` is derived from the setup checklist, never set by hand. An
 * approved card (`not_configured` or `configured`) is `configured` exactly when
 * every setup task is done, and drops back to `not_configured` when one is
 * reopened. A card with no setup tasks is vacuously configured once approved.
 * `proposed` is left alone: approval is a human decision, and finishing the
 * checklist does not imply it. Run-evidence values are not handled here; the
 * validator refuses them before this is called.
 */
export function deriveReadiness(readiness: Readiness, setup: readonly SetupTask[]): Readiness {
  if (readiness !== "not_configured" && readiness !== "configured") return readiness;
  return setup.every((task) => task.done) ? "configured" : "not_configured";
}

/** Aggregate card readiness counts, as shown in the canvas status bar. */
export function readinessSummary(
  definition: WorkflowDefinition,
): Record<Readiness, number> & { cards: number } {
  const summary = {
    cards: definition.nodes.length,
    proposed: 0,
    not_configured: 0,
    configured: 0,
    tested: 0,
    operational: 0,
  };
  for (const node of definition.nodes) summary[node.readiness] += 1;
  return summary;
}
