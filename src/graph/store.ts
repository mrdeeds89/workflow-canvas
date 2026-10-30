import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { migrateToCurrent } from "./migrate.ts";
import { validateWorkflow } from "./validate.ts";
import type { ValidationIssue, WorkflowDefinition } from "./types.ts";
import { SCHEMA_VERSION } from "./types.ts";

export type SaveResult =
  | { ok: true; value: WorkflowDefinition }
  | { ok: false; code: "invalid" | "conflict" | "not_found"; issues?: ValidationIssue[] };

export type WorkflowStore = {
  create(input: { title: string; description?: string }): WorkflowDefinition;
  save(doc: WorkflowDefinition, expectedRevision: number): SaveResult;
  load(id: string): WorkflowDefinition | null;
  close(): void;
};

export function openStore(path: string): WorkflowStore {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      document TEXT NOT NULL
    )
  `);

  const insert = db.prepare(
    "INSERT INTO workflows (id, revision, document) VALUES (?, ?, ?)",
  );
  const update = db.prepare(
    "UPDATE workflows SET revision = ?, document = ? WHERE id = ? AND revision = ?",
  );
  const select = db.prepare(
    "SELECT revision, document FROM workflows WHERE id = ?",
  );

  return {
    create(input) {
      const doc: WorkflowDefinition = {
        schemaVersion: SCHEMA_VERSION,
        id: randomUUID(),
        title: input.title,
        description: input.description ?? "",
        revision: 1,
        nodes: [],
        edges: [],
        groups: [],
        sourceReferences: [],
      };
      const validated = validateWorkflow(doc);
      if (!validated.ok) {
        throw new Error(validated.issues.map((item) => item.message).join("; "));
      }
      insert.run(validated.value.id, validated.value.revision, JSON.stringify(validated.value));
      return validated.value;
    },

    save(doc, expectedRevision) {
      const validated = validateWorkflow(doc);
      if (!validated.ok) return { ok: false, code: "invalid", issues: validated.issues };
      if (validated.value.revision !== expectedRevision) {
        return { ok: false, code: "conflict" };
      }
      const next: WorkflowDefinition = {
        ...validated.value,
        revision: expectedRevision + 1,
      };
      const result = update.run(
        next.revision,
        JSON.stringify(next),
        next.id,
        expectedRevision,
      );
      if (result.changes !== 1) {
        const existing = select.get(next.id) as { revision: number } | undefined;
        return { ok: false, code: existing ? "conflict" : "not_found" };
      }
      return { ok: true, value: next };
    },

    /**
     * Read a workflow, migrating older stored schemas forward in memory.
     *
     * Migration is lazy and does not rewrite the row. The stored document is
     * only replaced when the client saves, so a failed migration can never
     * damage data at rest.
     */
    load(id) {
      const row = select.get(id) as { revision: number; document: string } | undefined;
      if (!row) return null;

      const migration = migrateToCurrent(JSON.parse(row.document) as unknown);
      if (!migration.ok) {
        throw new Error(
          `Stored workflow ${id} has unreadable schema version ${String(migration.from)}.`,
        );
      }

      const validated = validateWorkflow(migration.value);
      if (!validated.ok) {
        const detail = validated.issues.map((item) => `${item.path}: ${item.message}`).join("; ");
        throw new Error(
          migration.migrated
            ? `Stored workflow ${id} failed validation after migration from schema ${migration.from}: ${detail}`
            : `Stored workflow ${id} failed validation: ${detail}`,
        );
      }
      return validated.value;
    },

    close() {
      db.close();
    },
  };
}
