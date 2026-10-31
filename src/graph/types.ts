export const SCHEMA_VERSION = 4;

/** Versions this build can read. Older ones are migrated forward on load. */
export const READABLE_SCHEMA_VERSIONS = [1, 2, 3, 4] as const;

/** Workflow brief length. Same bound as other stored prose fields. */
export const MAX_BRIEF_LENGTH = 20_000;

/**
 * Suggested headings for a workflow brief. A writing convention only: the
 * server stores one string and does not require, parse, or invent these.
 */
export const BRIEF_HEADINGS = [
  "Purpose",
  "Inputs required",
  "Expected outputs",
  "Success criteria",
  "Limits",
  "Open questions",
] as const;

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

/**
 * How a card would be handed to Hermes if a run is ever requested.
 *
 * Plain data. Naming a profile or a skill here does not grant it anything and
 * does not start anything: Canvas never executes. A Hermes-side conductor
 * checks these names against its own private allowlist before it acts.
 */
export type RunSettings = {
  /** Hermes profile that would do this step, or empty when not chosen yet. */
  executor: string;
  /** Hermes skill names to load for this step. */
  skills: string[];
  /** Upper bound for one attempt, in minutes. */
  maxRuntimeMinutes: number;
};

export const DEFAULT_MAX_RUNTIME_MINUTES = 30;
export const MAX_RUNTIME_MINUTES = 240;
export const MAX_SKILLS = 20;
/** Hermes profile names: lowercase letters, digits, hyphen, underscore. */
export const EXECUTOR_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Skill names, optionally with a category path such as `research/briefing`. */
export const SKILL_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}(\/[a-z0-9][a-z0-9_.-]{0,63}){0,3}$/;

export function defaultRunSettings(): RunSettings {
  return { executor: "", skills: [], maxRuntimeMinutes: DEFAULT_MAX_RUNTIME_MINUTES };
}

/** True for a skill name that is safe to pass to Hermes as one argument. */
export function isSkillName(value: string): boolean {
  return SKILL_PATTERN.test(value) && !value.split("/").some((part) => part === "." || part === "..");
}

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
  /** Run settings. Ignored for approval, artifact, and note cards. */
  run: RunSettings;
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
  /**
   * Workflow-level plain text for people and for a later assistant.
   * Stored and returned verbatim. Not HTML, not a command, and not authority
   * to run anything. See the workflow brief read contract in docs/ARCHITECTURE.md.
   */
  brief: string;
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
