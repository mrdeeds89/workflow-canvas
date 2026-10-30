import type { EdgeKind, NodeKind, Readiness, WorkflowNode } from "../../src/graph/types.ts";

export const CARD_KINDS: readonly { kind: NodeKind; label: string; hint: string }[] = [
  { kind: "task", label: "Task", hint: "A step of work" },
  { kind: "agent", label: "Agent", hint: "Work an agent does" },
  { kind: "integration", label: "Integration", hint: "An outside tool or service" },
  { kind: "approval", label: "Approval", hint: "A human sign-off gate" },
  { kind: "artifact", label: "Artifact", hint: "Something produced" },
  { kind: "note", label: "Note", hint: "Context, not a step" },
];

export const KIND_LABEL: Record<NodeKind, string> = Object.fromEntries(
  CARD_KINDS.map(({ kind, label }) => [kind, label]),
) as Record<NodeKind, string>;

export const READINESS_LABEL: Record<Readiness, string> = {
  proposed: "Proposed",
  not_configured: "Not configured",
  configured: "Configured",
  tested: "Tested",
  operational: "Operational",
};

export const EDGE_LABEL: Record<EdgeKind, string> = {
  requires: "Requires",
  data: "Data",
  conditional: "Conditional",
  revision: "Revision",
};

/**
 * Random id without crypto.randomUUID, which browsers withhold from plain
 * http:// pages. The service is reached over the LAN without TLS, so this
 * has to work outside a secure context.
 */
export function makeId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A blank card. Every new card starts proposed: approval is a human step. */
export function newCard(kind: NodeKind, position: { x: number; y: number }): WorkflowNode {
  return {
    id: makeId("card"),
    title: `New ${KIND_LABEL[kind].toLowerCase()}`,
    description: "",
    type: kind,
    position,
    owner: kind === "agent" ? "agent" : kind === "approval" ? "human" : "unassigned",
    instructions: "",
    spec: "",
    readiness: "proposed",
    proposal: { agentOwns: [], youOwn: [] },
    setup: [],
    inputs: [],
    outputs: [],
    acceptanceCriteria: [],
    inferred: false,
  };
}
