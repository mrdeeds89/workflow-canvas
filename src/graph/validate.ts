import {
  DESIGN_TIME_READINESS,
  RUN_EVIDENCE_READINESS,
  SCHEMA_VERSION,
  deriveReadiness,
  type EdgeKind,
  type NodeKind,
  type Owner,
  type Port,
  type Proposal,
  type Readiness,
  type SetupTask,
  type SourceReference,
  type ValidationIssue,
  type ValidationResult,
  type WorkflowEdge,
  type WorkflowGroup,
  type WorkflowNode,
} from "./types.ts";

const NODE_KINDS = new Set<NodeKind>([
  "task",
  "agent",
  "integration",
  "approval",
  "artifact",
  "note",
]);
const OWNERS = new Set<Owner>(["human", "agent", "unassigned"]);
const EDGE_KINDS = new Set<EdgeKind>(["requires", "data", "conditional", "revision"]);
const READINESS = new Set<Readiness>([...DESIGN_TIME_READINESS, ...RUN_EVIDENCE_READINESS]);
const DESIGN_TIME = new Set<Readiness>(DESIGN_TIME_READINESS);

const MAX_SPEC = 20_000;
const MAX_LINK = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A setup task may carry a reference link. Only absolute http(s) URLs are
 * allowed, so stored text cannot become a javascript: or data: payload when
 * the canvas renders it as an anchor.
 */
function isSafeLink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_LINK) return false;
  if (value === "") return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export function validateWorkflow(input: unknown): ValidationResult {
  if (!isRecord(input) || input.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      issues: [
        issue(
          "unsupported_schema_version",
          "schemaVersion",
          `Unsupported schema version. Expected ${SCHEMA_VERSION}.`,
        ),
      ],
    };
  }

  const issues: ValidationIssue[] = [];
  const id = isId(input.id) ? input.id : "";
  if (!id) {
    issues.push(issue("invalid_workflow", "id", "Workflow id must be a non-empty string."));
  }
  if (!isText(input.title, 500)) {
    issues.push(issue("invalid_workflow", "title", "Workflow title must be text up to 500 characters."));
  }
  if (!isText(input.description, 20_000)) {
    issues.push(issue("invalid_workflow", "description", "Workflow description must be text."));
  }
  if (!Number.isInteger(input.revision) || (input.revision as number) < 1) {
    issues.push(issue("invalid_workflow", "revision", "Revision must be an integer of 1 or greater."));
  }

  const nodes = parseNodes(input.nodes, issues);
  const edges = parseEdges(input.edges, issues);
  const groups = parseGroups(input.groups, issues);
  const sourceReferences = parseSources(input.sourceReferences, issues);
  const nodeIds = new Set(nodes.map((node) => node.id));

  issues.push(...duplicateIds(rawIds(input.nodes), "nodes"));
  issues.push(...duplicateIds(edges.map((edge) => edge.id), "edges"));
  issues.push(...danglingEdges(edges, nodeIds));
  issues.push(...danglingGroups(groups, nodeIds));
  issues.push(...dependencyCycles(edges, nodeIds));

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      id,
      title: input.title as string,
      description: input.description as string,
      revision: input.revision as number,
      nodes,
      edges,
      groups,
      sourceReferences,
    },
  };
}

function parseNodes(value: unknown, issues: ValidationIssue[]): WorkflowNode[] {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_workflow", "nodes", "Nodes must be an array."));
    return [];
  }
  return value.flatMap((item, index) => {
    const node = parseNode(item, `nodes[${index}]`, issues);
    return node ? [node] : [];
  });
}

function parseNode(value: unknown, path: string, issues: ValidationIssue[]): WorkflowNode | null {
  if (!isRecord(value)) {
    issues.push(issue("invalid_node", path, "Node must be an object."));
    return null;
  }

  if (!NODE_KINDS.has(value.type as NodeKind)) {
    issues.push(
      issue("invalid_node", `${path}.type`, `Card type must be one of: ${[...NODE_KINDS].join(", ")}.`),
    );
    return null;
  }

  // Bound once so the narrowed type survives to where the position is built.
  const position = isRecord(value.position) ? value.position : null;
  const missing =
    !isId(value.id) ||
    !isText(value.title, 500) ||
    !isText(value.description, 20_000) ||
    position === null ||
    !finiteNumber(position.x) ||
    !finiteNumber(position.y) ||
    !OWNERS.has(value.owner as Owner) ||
    !isText(value.instructions, 20_000) ||
    !Array.isArray(value.inputs) ||
    !Array.isArray(value.outputs) ||
    !Array.isArray(value.setup) ||
    !Array.isArray(value.acceptanceCriteria) ||
    typeof value.inferred !== "boolean";
  if (missing || position === null) {
    issues.push(issue("invalid_node", path, "Node is missing a required field."));
    return null;
  }

  const spec = parseSpec(value.spec, `${path}.spec`, issues);
  const readiness = parseReadiness(value.readiness, `${path}.readiness`, issues);
  const proposal = parseProposal(value.proposal, `${path}.proposal`, issues);
  const setup = parseSetup(value.setup, `${path}.setup`, issues);
  const inputs = parsePorts(value.inputs, `${path}.inputs`, issues);
  const outputs = parsePorts(value.outputs, `${path}.outputs`, issues);
  const acceptanceCriteria = parseStrings(
    value.acceptanceCriteria,
    `${path}.acceptanceCriteria`,
    issues,
  );

  if (
    spec === null ||
    readiness === null ||
    !proposal ||
    !setup ||
    !inputs ||
    !outputs ||
    !acceptanceCriteria
  ) {
    return null;
  }

  // `configured` is computed from the checklist rather than accepted from the
  // client, so the badge can never contradict the card's own setup tasks.
  return {
    id: value.id as string,
    title: value.title as string,
    description: value.description as string,
    type: value.type as NodeKind,
    position: { x: position.x as number, y: position.y as number },
    owner: value.owner as Owner,
    instructions: value.instructions as string,
    spec,
    readiness: deriveReadiness(readiness, setup),
    proposal,
    setup,
    inputs,
    outputs,
    acceptanceCriteria,
    inferred: value.inferred as boolean,
  };
}

/**
 * The spec is stored text, never evaluated. It must parse as JSON so the
 * canvas can present it as structured data, but nothing here interprets it.
 */
function parseSpec(value: unknown, path: string, issues: ValidationIssue[]): string | null {
  if (!isText(value, MAX_SPEC)) {
    issues.push(issue("invalid_node", path, `Spec must be text up to ${MAX_SPEC} characters.`));
    return null;
  }
  if (value.trim() === "") return "";
  try {
    JSON.parse(value);
  } catch {
    issues.push(issue("invalid_spec", path, "Spec must be valid JSON, or empty."));
    return null;
  }
  return value;
}

function parseReadiness(value: unknown, path: string, issues: ValidationIssue[]): Readiness | null {
  if (!READINESS.has(value as Readiness)) {
    issues.push(
      issue("invalid_node", path, `Readiness must be one of: ${[...READINESS].join(", ")}.`),
    );
    return null;
  }
  const readiness = value as Readiness;
  if (!DESIGN_TIME.has(readiness)) {
    issues.push(
      issue(
        "readiness_requires_run_evidence",
        path,
        `"${readiness}" reports the outcome of a real run. This editor does not execute workflows, so it cannot assert it. Allowed here: ${DESIGN_TIME_READINESS.join(", ")}.`,
      ),
    );
    return null;
  }
  return readiness;
}

function parseProposal(value: unknown, path: string, issues: ValidationIssue[]): Proposal | null {
  if (!isRecord(value) || !Array.isArray(value.agentOwns) || !Array.isArray(value.youOwn)) {
    issues.push(issue("invalid_node", path, "Proposal needs an agentOwns list and a youOwn list."));
    return null;
  }
  const agentOwns = parseStrings(value.agentOwns, `${path}.agentOwns`, issues);
  const youOwn = parseStrings(value.youOwn, `${path}.youOwn`, issues);
  if (!agentOwns || !youOwn) return null;
  return { agentOwns, youOwn };
}

function parseSetup(value: unknown, path: string, issues: ValidationIssue[]): SetupTask[] | null {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_node", path, "Setup must be an array."));
    return null;
  }
  const tasks: SetupTask[] = [];
  for (const [index, item] of value.entries()) {
    const at = `${path}[${index}]`;
    if (
      !isRecord(item) ||
      !isId(item.id) ||
      !isText(item.text, 2_000) ||
      !isText(item.detail, 2_000) ||
      typeof item.done !== "boolean"
    ) {
      issues.push(issue("invalid_setup_task", at, "Setup task is incomplete."));
      return null;
    }
    if (!isSafeLink(item.link)) {
      issues.push(
        issue("unsafe_link", `${at}.link`, "A setup task link must be empty or an http(s) URL."),
      );
      return null;
    }
    tasks.push({
      id: item.id,
      text: item.text,
      detail: item.detail,
      link: item.link,
      done: item.done,
    });
  }
  return tasks;
}

function parsePorts(value: unknown, path: string, issues: ValidationIssue[]): Port[] | null {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_node", path, "Ports must be an array."));
    return null;
  }
  const ports: Port[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || !isId(item.id) || !isText(item.name, 200)) {
      issues.push(issue("invalid_node", `${path}[${index}]`, "Port needs an id and name."));
      return null;
    }
    ports.push({ id: item.id, name: item.name });
  }
  return ports;
}

function parseStrings(value: unknown, path: string, issues: ValidationIssue[]): string[] | null {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_node", path, "Expected a list of text entries."));
    return null;
  }
  const texts: string[] = [];
  for (const [index, item] of value.entries()) {
    if (!isText(item, 2_000)) {
      issues.push(issue("invalid_node", `${path}[${index}]`, "Each entry must be text."));
      return null;
    }
    texts.push(item);
  }
  return texts;
}

function parseEdges(value: unknown, issues: ValidationIssue[]): WorkflowEdge[] {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_workflow", "edges", "Edges must be an array."));
    return [];
  }
  const edges: WorkflowEdge[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item) || !isId(item.id) || typeof item.source !== "string" || typeof item.target !== "string") {
      issues.push(issue("invalid_edge", `edges[${index}]`, "Edge is missing an id or endpoint."));
      return;
    }
    if (!EDGE_KINDS.has(item.type as EdgeKind) || !isText(item.label, 500) || typeof item.inferred !== "boolean") {
      issues.push(issue("invalid_edge", `edges[${index}]`, "Edge type, label, or provenance is invalid."));
      return;
    }
    if (item.type === "conditional" && item.label.trim() === "") {
      issues.push(issue("invalid_edge", `edges[${index}].label`, "A conditional edge needs a human-readable label."));
      return;
    }
    edges.push({
      id: item.id,
      source: item.source,
      target: item.target,
      type: item.type as EdgeKind,
      label: item.label,
      inferred: item.inferred,
    });
  });
  return edges;
}

function parseGroups(value: unknown, issues: ValidationIssue[]): WorkflowGroup[] {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_workflow", "groups", "Groups must be an array."));
    return [];
  }
  const groups: WorkflowGroup[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item) || !isId(item.id) || !isText(item.title, 200) || !Array.isArray(item.memberIds)) {
      issues.push(issue("invalid_group", `groups[${index}]`, "Group is incomplete."));
      return;
    }
    if (!item.memberIds.every((member) => typeof member === "string")) {
      issues.push(issue("invalid_group", `groups[${index}].memberIds`, "Group members must be node ids."));
      return;
    }
    groups.push({
      id: item.id,
      title: item.title,
      memberIds: item.memberIds as string[],
    });
  });
  return groups;
}

function parseSources(value: unknown, issues: ValidationIssue[]): SourceReference[] {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_workflow", "sourceReferences", "Source references must be an array."));
    return [];
  }
  const sources: SourceReference[] = [];
  value.forEach((item, index) => {
    if (
      !isRecord(item) ||
      !isId(item.id) ||
      !isText(item.documentId, 500) ||
      !isText(item.hash, 128) ||
      !isText(item.version, 128) ||
      !isText(item.section, 500)
    ) {
      issues.push(issue("invalid_source", `sourceReferences[${index}]`, "Source reference is incomplete."));
      return;
    }
    sources.push({
      id: item.id,
      documentId: item.documentId,
      hash: item.hash,
      version: item.version,
      section: item.section,
    });
  });
  return sources;
}

function rawIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []));
}

function duplicateIds(ids: string[], collection: string): ValidationIssue[] {
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      issues.push(issue("duplicate_id", `${collection}[${index}].id`, `${collection} ids must be unique.`));
    }
    seen.add(id);
  });
  return issues;
}

function danglingEdges(edges: WorkflowEdge[], nodeIds: Set<string>): ValidationIssue[] {
  return edges.flatMap((edge, index) => {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) return [];
    return [
      issue(
        "dangling_edge",
        `edges[${index}]`,
        "Edge endpoints must reference existing nodes.",
      ),
    ];
  });
}

function danglingGroups(groups: WorkflowGroup[], nodeIds: Set<string>): ValidationIssue[] {
  return groups.flatMap((group, index) => {
    if (group.memberIds.every((member) => nodeIds.has(member))) return [];
    return [
      issue(
        "dangling_group",
        `groups[${index}].memberIds`,
        "Group members must reference existing nodes.",
      ),
    ];
  });
}

function dependencyCycles(edges: WorkflowEdge[], nodeIds: Set<string>): ValidationIssue[] {
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) outgoing.set(id, []);
  for (const edge of edges) {
    if (edge.type !== "requires") continue;
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    outgoing.get(edge.source)?.push(edge.target);
  }

  const unseen = 0;
  const visiting = 1;
  const done = 2;
  const state = new Map<string, number>();
  for (const id of nodeIds) state.set(id, unseen);

  function visit(id: string): boolean {
    state.set(id, visiting);
    for (const next of outgoing.get(id) ?? []) {
      const nextState = state.get(next);
      if (nextState === visiting) return true;
      if (nextState === unseen && visit(next)) return true;
    }
    state.set(id, done);
    return false;
  }

  for (const id of nodeIds) {
    if (state.get(id) === unseen && visit(id)) {
      return [
        issue(
          "dependency_cycle",
          "edges",
          "Dependency edges must not form a cycle. Revision links are not dependencies.",
        ),
      ];
    }
  }
  return [];
}
