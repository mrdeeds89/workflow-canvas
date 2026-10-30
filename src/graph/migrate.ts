import { SCHEMA_VERSION } from "./types.ts";

/**
 * Forward migration for stored workflow documents.
 *
 * Migration is non-destructive: it adds the fields a newer schema requires and
 * preserves anything the old document already held. It never drops user text.
 * The result is still passed through validateWorkflow, so a migration that
 * produces an invalid document fails loudly instead of corrupting a row.
 */

export type MigrationResult =
  | { ok: true; value: unknown; from: number; to: number; migrated: boolean }
  | { ok: false; code: "unknown_version"; from: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * v1 -> v2
 *
 * - `type: "gate"` becomes `type: "approval"`. v2 names the six card kinds
 *   seen in the reference design; "approval" is the gate.
 * - `checklist[]` becomes `setup[]`, gaining a `detail` and a `link`.
 * - New per-card fields: `spec` (empty), `readiness`, `proposal`.
 * - `readiness` is derived, never invented: a card whose setup checklist is
 *   non-empty and fully checked becomes "configured", otherwise "proposed".
 *   A v1 document carries no approval or run evidence, so migration never
 *   produces "not_configured", "tested", or "operational".
 */
function migrateV1ToV2(document: Record<string, unknown>): Record<string, unknown> {
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];

  return {
    ...document,
    schemaVersion: 2,
    nodes: nodes.map((node) => {
      if (!isRecord(node)) return node;

      const checklist = Array.isArray(node.checklist) ? node.checklist : [];
      const setup = checklist.map((item) =>
        isRecord(item)
          ? { id: item.id, text: item.text, detail: "", link: "", done: item.done }
          : item,
      );

      const allChecked =
        setup.length > 0 &&
        setup.every((item) => isRecord(item) && item.done === true);

      const { checklist: _removed, ...rest } = node;

      return {
        ...rest,
        type: node.type === "gate" ? "approval" : node.type,
        spec: "",
        readiness: allChecked ? "configured" : "proposed",
        proposal: { agentOwns: [], youOwn: [] },
        setup,
      };
    }),
  };
}

const MIGRATIONS: Record<number, (document: Record<string, unknown>) => Record<string, unknown>> = {
  1: migrateV1ToV2,
};

/** Bring a stored document up to SCHEMA_VERSION, one step at a time. */
export function migrateToCurrent(input: unknown): MigrationResult {
  if (!isRecord(input) || typeof input.schemaVersion !== "number") {
    return { ok: false, code: "unknown_version", from: isRecord(input) ? input.schemaVersion : input };
  }

  const from = input.schemaVersion;
  if (from === SCHEMA_VERSION) {
    return { ok: true, value: input, from, to: SCHEMA_VERSION, migrated: false };
  }
  if (from > SCHEMA_VERSION || from < 1) {
    return { ok: false, code: "unknown_version", from };
  }

  let document = input;
  for (let version = from; version < SCHEMA_VERSION; version += 1) {
    const step = MIGRATIONS[version];
    if (!step) return { ok: false, code: "unknown_version", from: version };
    document = step(document);
  }

  return { ok: true, value: document, from, to: SCHEMA_VERSION, migrated: true };
}
