/**
 * How workflows are organised: projects in creation order, and the workflows
 * in each project (or Unfiled) in their manual order. Organisation is kept
 * beside each workflow document, not inside it, so moving or reordering never
 * changes a workflow's revision or conflicts with an open editor.
 *
 * Shared by the server and the browser, so it must not import Node modules.
 */

export type ProjectSummary = { id: string; title: string };

export type WorkflowSummary = {
  id: string;
  title: string;
  /** null = Unfiled. */
  projectId: string | null;
  updatedAt: number;
};

export type Library = { projects: ProjectSummary[]; workflows: WorkflowSummary[] };

export const MAX_PROJECT_TITLE = 200;
