import { SCHEMA_VERSION, type ValidationIssue, type WorkflowDefinition } from "./types.ts";
import { migrateToCurrent } from "./migrate.ts";
import { validateWorkflow } from "./validate.ts";

/**
 * The compatibility boundary for workflow documents that arrive from OUTSIDE
 * the store: an uploaded file, another installation's export, a hand-edited
 * document. It never mutates anything and never touches the filesystem or the
 * network. It classifies the version precisely, migrates a legacy document in
 * memory, validates the result, adds the scoped-uniqueness checks the live
 * validator does not perform, and reports every field that import would discard
 * so a person can cancel instead of silently losing content.
 *
 * This module is Node-free so the browser can preview an import with the exact
 * same contract the server enforces.
 */

export type DiscardedField = { path: string; field: string };

export type CompatibilityResult =
  | {
      ok: true;
      value: WorkflowDefinition;
      from: number;
      to: number;
      migrated: boolean;
      discardedFields: DiscardedField[];
    }
  | { ok: false; issues: ValidationIssue[]; discardedFields: DiscardedField[]; from: number | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message };
}

/**
 * Classify `schemaVersion` with an actionable message for each failure mode:
 * missing, not a number, fractional, zero/negative, or newer than this build.
 */
export function classifyVersion(input: unknown): { ok: true; from: number } | { ok: false; issue: ValidationIssue } {
  if (!isRecord(input)) {
    return { ok: false, issue: issue("not_an_object", "", "A workflow file must be a JSON object.") };
  }
  const version = input.schemaVersion;
  if (version === undefined || version === null) {
    return { ok: false, issue: issue("schema_version_missing", "schemaVersion", "The file has no schemaVersion.") };
  }
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return {
      ok: false,
      issue: issue("schema_version_not_a_number", "schemaVersion", "schemaVersion must be a number."),
    };
  }
  if (!Number.isInteger(version)) {
    return {
      ok: false,
      issue: issue("schema_version_fractional", "schemaVersion", "schemaVersion must be a whole number."),
    };
  }
  if (version < 1) {
    return {
      ok: false,
      issue: issue("schema_version_out_of_range", "schemaVersion", "schemaVersion must be 1 or greater."),
    };
  }
  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      issue: issue(
        "schema_version_future",
        "schemaVersion",
        `This file is version ${version}; this build reads up to version ${SCHEMA_VERSION}. Update the app to open it.`,
      ),
    };
  }
  return { ok: true, from: version };
}

const WORKFLOW_KEYS = new Set([
  "schemaVersion",
  "id",
  "title",
  "description",
  "brief",
  "revision",
  "nodes",
  "edges",
  "groups",
  "sourceReferences",
]);
const NODE_KEYS = new Set([
  "id",
  "title",
  "description",
  "type",
  "position",
  "owner",
  "instructions",
  "spec",
  "readiness",
  "proposal",
  "setup",
  "inputs",
  "outputs",
  "acceptanceCriteria",
  "inferred",
  "run",
  "deliverTo",
]);
const POSITION_KEYS = new Set(["x", "y"]);
const PROPOSAL_KEYS = new Set(["agentOwns", "youOwn"]);
const RUN_KEYS = new Set(["executor", "skills", "maxRuntimeMinutes"]);
const SETUP_KEYS = new Set(["id", "text", "detail", "link", "done"]);
const PORT_KEYS = new Set(["id", "name"]);
const EDGE_KEYS = new Set(["id", "source", "target", "type", "label", "inferred"]);
const GROUP_KEYS = new Set(["id", "title", "memberIds"]);
const SOURCE_KEYS = new Set(["id", "documentId", "hash", "version", "section"]);

function unknownKeys(value: unknown, known: Set<string>, path: string, out: DiscardedField[]): void {
  if (!isRecord(value)) return;
  // Object.keys reads own enumerable keys; a Set membership test is not
  // prototype-sensitive, so "__proto__" and friends are treated as plain names.
  for (const key of Object.keys(value)) {
    if (!known.has(key)) out.push({ path, field: key });
  }
}

/**
 * Every field that import would drop, reported on the already-migrated document
 * so a renamed legacy field (such as v1 `checklist`) is not falsely flagged.
 */
export function discardedFields(document: unknown): DiscardedField[] {
  const out: DiscardedField[] = [];
  if (!isRecord(document)) return out;
  unknownKeys(document, WORKFLOW_KEYS, "", out);

  if (Array.isArray(document.nodes)) {
    document.nodes.forEach((node, i) => {
      if (!isRecord(node)) return;
      unknownKeys(node, NODE_KEYS, `nodes[${i}]`, out);
      unknownKeys(node.position, POSITION_KEYS, `nodes[${i}].position`, out);
      unknownKeys(node.proposal, PROPOSAL_KEYS, `nodes[${i}].proposal`, out);
      unknownKeys(node.run, RUN_KEYS, `nodes[${i}].run`, out);
      if (Array.isArray(node.setup)) {
        node.setup.forEach((task, j) => unknownKeys(task, SETUP_KEYS, `nodes[${i}].setup[${j}]`, out));
      }
      if (Array.isArray(node.inputs)) {
        node.inputs.forEach((port, j) => unknownKeys(port, PORT_KEYS, `nodes[${i}].inputs[${j}]`, out));
      }
      if (Array.isArray(node.outputs)) {
        node.outputs.forEach((port, j) => unknownKeys(port, PORT_KEYS, `nodes[${i}].outputs[${j}]`, out));
      }
    });
  }
  if (Array.isArray(document.edges)) {
    document.edges.forEach((edge, i) => unknownKeys(edge, EDGE_KEYS, `edges[${i}]`, out));
  }
  if (Array.isArray(document.groups)) {
    document.groups.forEach((group, i) => unknownKeys(group, GROUP_KEYS, `groups[${i}]`, out));
  }
  if (Array.isArray(document.sourceReferences)) {
    document.sourceReferences.forEach((src, i) => unknownKeys(src, SOURCE_KEYS, `sourceReferences[${i}]`, out));
  }
  return out;
}

function duplicatesIn(values: unknown[], makeIssue: (index: number) => ValidationIssue): ValidationIssue[] {
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  values.forEach((raw, index) => {
    if (typeof raw !== "string") return;
    if (seen.has(raw)) issues.push(makeIssue(index));
    seen.add(raw);
  });
  return issues;
}

function idsOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (isRecord(item) ? item.id : undefined));
}

/**
 * Scoped-uniqueness checks the live validator does not run: group ids, source
 * ids, each node's setup ids, each node's input and output port ids, and
 * distinct group membership. Identity is never repaired here, only reported.
 */
export function scopedDuplicateIssues(document: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(document)) return issues;

  issues.push(
    ...duplicatesIn(idsOf(document.groups), (i) =>
      issue("duplicate_id", `groups[${i}].id`, "Group ids must be unique."),
    ),
  );
  issues.push(
    ...duplicatesIn(idsOf(document.sourceReferences), (i) =>
      issue("duplicate_id", `sourceReferences[${i}].id`, "Source reference ids must be unique."),
    ),
  );

  if (Array.isArray(document.nodes)) {
    document.nodes.forEach((node, n) => {
      if (!isRecord(node)) return;
      issues.push(
        ...duplicatesIn(idsOf(node.setup), (i) =>
          issue("duplicate_id", `nodes[${n}].setup[${i}].id`, "Setup task ids must be unique within a card."),
        ),
      );
      issues.push(
        ...duplicatesIn(idsOf(node.inputs), (i) =>
          issue("duplicate_id", `nodes[${n}].inputs[${i}].id`, "Input port ids must be unique within a card."),
        ),
      );
      issues.push(
        ...duplicatesIn(idsOf(node.outputs), (i) =>
          issue("duplicate_id", `nodes[${n}].outputs[${i}].id`, "Output port ids must be unique within a card."),
        ),
      );
    });
  }

  if (Array.isArray(document.groups)) {
    document.groups.forEach((group, g) => {
      if (!isRecord(group) || !Array.isArray(group.memberIds)) return;
      issues.push(
        ...duplicatesIn(group.memberIds, (i) =>
          issue("duplicate_group_member", `groups[${g}].memberIds[${i}]`, "A node may appear in a group only once."),
        ),
      );
    });
  }
  return issues;
}

function mergeIssues(a: ValidationIssue[], b: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set(a.map((it) => `${it.code}\u0000${it.path}`));
  const merged = [...a];
  for (const it of b) {
    const key = `${it.code}\u0000${it.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(it);
    }
  }
  return merged;
}

/**
 * Parse an external workflow document safely: classify its version, migrate it
 * in memory, validate it, apply the scoped-uniqueness checks, and report
 * discarded fields. On success the value is a normalized current-schema
 * definition; nothing is written and the input is not mutated.
 */
export function parseExternalWorkflow(input: unknown): CompatibilityResult {
  const version = classifyVersion(input);
  if (!version.ok) {
    return { ok: false, issues: [version.issue], discardedFields: [], from: null };
  }

  const migration = migrateToCurrent(input);
  if (!migration.ok) {
    return {
      ok: false,
      issues: [issue("unsupported_schema_version", "schemaVersion", `No migration path from version ${version.from}.`)],
      discardedFields: [],
      from: version.from,
    };
  }

  const migrated = migration.value;
  const discarded = discardedFields(migrated);
  const scoped = scopedDuplicateIssues(migrated);
  const validated = validateWorkflow(migrated);

  if (!validated.ok) {
    return {
      ok: false,
      issues: mergeIssues(validated.issues, scoped),
      discardedFields: discarded,
      from: version.from,
    };
  }
  if (scoped.length > 0) {
    // The structure is otherwise valid, but a scoped id collides. Reject rather
    // than import a document whose own identities are ambiguous.
    return { ok: false, issues: scoped, discardedFields: discarded, from: version.from };
  }

  return {
    ok: true,
    value: validated.value,
    from: version.from,
    to: SCHEMA_VERSION,
    migrated: migration.migrated,
    discardedFields: discarded,
  };
}
