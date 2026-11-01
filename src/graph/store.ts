import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { migrateToCurrent } from "./migrate.ts";
import { validateWorkflow } from "./validate.ts";
import type { ValidationIssue, WorkflowDefinition } from "./types.ts";
import { SCHEMA_VERSION } from "./types.ts";
import { createHarnessStore, type HarnessStore } from "../harness/store.ts";
import { createRunStore, type RunStore } from "./runs.ts";
import { createConductorStore, type ConductorStore } from "./conductor.ts";

export type SaveResult =
  | { ok: true; value: WorkflowDefinition }
  | { ok: false; code: "invalid" | "conflict" | "not_found"; issues?: ValidationIssue[] };

import type { Library, ProjectSummary } from "./library.ts";

export type { Library, ProjectSummary, WorkflowSummary } from "./library.ts";
export { MAX_PROJECT_TITLE } from "./library.ts";

export type MoveResult = { ok: true } | { ok: false; code: "not_found" | "no_such_project" };

export type WorkflowStore = {
  create(input: { title: string; description?: string; projectId?: string | null }): WorkflowDefinition;
  save(doc: WorkflowDefinition, expectedRevision: number): SaveResult;
  load(id: string): WorkflowDefinition | null;
  library(): Library;
  createProject(title: string): ProjectSummary;
  renameProject(id: string, title: string): ProjectSummary | null;
  /** Place a workflow in a project (null = Unfiled) at `index` in that list. */
  moveWorkflow(id: string, projectId: string | null, index: number): MoveResult;
  /** Remove a workflow for good. Returns false if it did not exist. */
  deleteWorkflow(id: string): boolean;
  /** Copy a workflow as a new one, placed right after the original. */
  duplicateWorkflow(id: string): WorkflowDefinition | null;
  /** Hermes job links and observations. Separate from documents and revisions. */
  harness: HarnessStore;
  /** Run requests and evidence. Canvas records; the conductor executes. */
  runs: RunStore;
  /** Connecting a Hermes machine: pairing, the conductor token, delivery targets. */
  conductor: ConductorStore;
  close(): void;
};

type WorkflowRow = {
  id: string;
  revision: number;
  document: string;
  project_id: string | null;
  position: number;
  updated_at: number;
};

export function openStore(path: string): WorkflowStore {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      document TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position INTEGER NOT NULL
    );
  `);
  upgradeWorkflowsTable(db);
  const harness = createHarnessStore(db);
  const runs = createRunStore(db);
  const conductor = createConductorStore(db);

  const insert = db.prepare(
    "INSERT INTO workflows (id, revision, document, project_id, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const update = db.prepare(
    "UPDATE workflows SET revision = ?, document = ?, updated_at = ? WHERE id = ? AND revision = ?",
  );
  const select = db.prepare(
    "SELECT id, revision, document, project_id, position, updated_at FROM workflows WHERE id = ?",
  );
  const listIds = db.prepare(
    "SELECT id FROM workflows WHERE project_id IS ? ORDER BY position, rowid",
  );
  const setPlace = db.prepare("UPDATE workflows SET project_id = ?, position = ? WHERE id = ?");
  const allWorkflows = db.prepare(
    "SELECT id, document, project_id, updated_at FROM workflows ORDER BY position, rowid",
  );
  const allProjects = db.prepare("SELECT id, title FROM projects ORDER BY position, rowid");
  const selectProject = db.prepare("SELECT id, title FROM projects WHERE id = ?");
  const insertProject = db.prepare(
    "INSERT INTO projects (id, title, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM projects))",
  );
  const renameProjectStmt = db.prepare("UPDATE projects SET title = ? WHERE id = ?");
  const removeWorkflow = db.prepare("DELETE FROM workflows WHERE id = ?");
  const removeHarnessLink = db.prepare("DELETE FROM harness_links WHERE workflow_id = ?");
  const removeHarnessObservations = db.prepare("DELETE FROM harness_observations WHERE workflow_id = ?");

  function idsIn(projectId: string | null): string[] {
    return (listIds.all(projectId) as { id: string }[]).map((row) => row.id);
  }

  /** Write a list's order back as positions 0..n-1. */
  function renumber(projectId: string | null, ids: string[]): void {
    ids.forEach((id, position) => setPlace.run(projectId, position, id));
  }

  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function insertAt(projectId: string | null, index: number, doc: WorkflowDefinition): void {
    insert.run(doc.id, doc.revision, JSON.stringify(doc), projectId, 0, Date.now());
    const ids = idsIn(projectId).filter((id) => id !== doc.id);
    ids.splice(clampIndex(index, ids.length), 0, doc.id);
    renumber(projectId, ids);
  }

  function projectExists(id: string): boolean {
    return selectProject.get(id) !== undefined;
  }

  function parseStored(id: string, document: string): WorkflowDefinition {
    const migration = migrateToCurrent(JSON.parse(document) as unknown);
    if (!migration.ok) {
      throw new Error(`Stored workflow ${id} has unreadable schema version ${String(migration.from)}.`);
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
  }

  return {
    create(input) {
      const projectId = input.projectId ?? null;
      if (projectId !== null && !projectExists(projectId)) {
        throw new Error(`No such project: ${projectId}`);
      }
      const doc: WorkflowDefinition = {
        schemaVersion: SCHEMA_VERSION,
        id: randomUUID(),
        title: input.title,
        description: input.description ?? "",
        brief: "",
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
      // New workflows go to the top of their list, where they are easy to find.
      transaction(() => insertAt(projectId, 0, validated.value));
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
      const result = update.run(next.revision, JSON.stringify(next), Date.now(), next.id, expectedRevision);
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
      const row = select.get(id) as WorkflowRow | undefined;
      if (!row) return null;
      return parseStored(id, row.document);
    },

    library() {
      const projects = allProjects.all() as ProjectSummary[];
      const order = new Map(projects.map((project, index) => [project.id, index]));
      const rows = allWorkflows.all() as Pick<WorkflowRow, "id" | "document" | "project_id" | "updated_at">[];
      const workflows = rows.map((row) => ({
        id: row.id,
        // The title is read straight from the stored JSON. A row that fails
        // to parse still appears, so it can be found and deleted.
        title: titleOf(row.document),
        projectId: row.project_id !== null && order.has(row.project_id) ? row.project_id : null,
        updatedAt: row.updated_at,
      }));
      return { projects, workflows };
    },

    createProject(title) {
      const project = { id: randomUUID(), title };
      insertProject.run(project.id, project.title);
      return project;
    },

    renameProject(id, title) {
      const result = renameProjectStmt.run(title, id);
      return result.changes === 1 ? { id, title } : null;
    },

    moveWorkflow(id, projectId, index) {
      return transaction((): MoveResult => {
        const row = select.get(id) as WorkflowRow | undefined;
        if (!row) return { ok: false, code: "not_found" };
        if (projectId !== null && !projectExists(projectId)) return { ok: false, code: "no_such_project" };

        const from = row.project_id;
        const target = idsIn(projectId).filter((other) => other !== id);
        target.splice(clampIndex(index, target.length), 0, id);
        renumber(projectId, target);
        if (from !== projectId) renumber(from, idsIn(from));
        return { ok: true };
      });
    },

    deleteWorkflow(id) {
      return transaction(() => {
        const row = select.get(id) as WorkflowRow | undefined;
        if (!row) return false;
        removeWorkflow.run(id);
        removeHarnessLink.run(id);
        removeHarnessObservations.run(id);
        runs.removeWorkflow(id);
        renumber(row.project_id, idsIn(row.project_id));
        return true;
      });
    },

    duplicateWorkflow(id) {
      return transaction(() => {
        const row = select.get(id) as WorkflowRow | undefined;
        if (!row) return null;
        const original = parseStored(id, row.document);
        const copy: WorkflowDefinition = {
          ...structuredClone(original),
          id: randomUUID(),
          title: copyTitle(original.title),
          revision: 1,
        };
        const index = idsIn(row.project_id).indexOf(id) + 1;
        insertAt(row.project_id, index, copy);
        return copy;
      });
    },

    harness,
    runs,
    conductor,

    close() {
      db.close();
    },
  };
}

/**
 * Add the organisation columns to a workflows table created before projects
 * existed. Existing workflows become Unfiled, keeping their creation order.
 */
function upgradeWorkflowsTable(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(workflows)").all() as { name: string }[]).map((column) => column.name),
  );
  if (!columns.has("project_id")) db.exec("ALTER TABLE workflows ADD COLUMN project_id TEXT");
  if (!columns.has("position")) {
    db.exec("ALTER TABLE workflows ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE workflows SET position = rowid");
  }
  if (!columns.has("updated_at")) {
    db.exec("ALTER TABLE workflows ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
  }
}

function clampIndex(index: number, length: number): number {
  if (!Number.isInteger(index) || index < 0) return 0;
  return Math.min(index, length);
}

function titleOf(document: string): string {
  try {
    const title = (JSON.parse(document) as { title?: unknown }).title;
    return typeof title === "string" ? title : "";
  } catch {
    return "";
  }
}

function copyTitle(title: string): string {
  const base = title.trim() === "" ? "Untitled workflow" : title;
  return `${base} (copy)`.slice(0, 500);
}
