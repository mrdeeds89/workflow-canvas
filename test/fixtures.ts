import { SCHEMA_VERSION } from "../src/graph/types.ts";

/**
 * Shared test fixtures. These build plain objects rather than typed values so
 * a test can override any field with deliberately invalid input.
 */

export function card(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    description: "",
    type: "task",
    position: { x: 0, y: 0 },
    owner: "unassigned",
    instructions: "",
    spec: "",
    readiness: "proposed",
    proposal: { agentOwns: [], youOwn: [] },
    setup: [],
    inputs: [],
    outputs: [],
    acceptanceCriteria: [],
    inferred: false,
    ...overrides,
  };
}

export function setupTask(id: string, overrides: Record<string, unknown> = {}) {
  return { id, text: id, detail: "", link: "", done: false, ...overrides };
}

export function emptyWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "wf-1",
    title: "Draft",
    description: "",
    revision: 1,
    nodes: [],
    edges: [],
    groups: [],
    sourceReferences: [],
    ...overrides,
  };
}

/** A v1 document, used to exercise forward migration. */
export function v1Workflow(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "wf-v1",
    title: "Legacy",
    description: "",
    revision: 3,
    nodes: [],
    edges: [],
    groups: [],
    sourceReferences: [],
    ...overrides,
  };
}

export function v1Node(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    description: "",
    type: "task",
    position: { x: 5, y: 7 },
    owner: "human",
    instructions: "",
    inputs: [],
    outputs: [],
    checklist: [],
    acceptanceCriteria: [],
    inferred: false,
    ...overrides,
  };
}
