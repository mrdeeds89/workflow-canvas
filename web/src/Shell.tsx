import { useCallback, useEffect, useRef, useState } from "react";
import { WorkflowEditor, type EditorHandle } from "./App.tsx";
import {
  createProject,
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  fetchLibrary,
  loadWorkflow,
  moveWorkflow,
  renameProject,
  saveWorkflow,
  type Library,
} from "./api.ts";
import { Sidebar, displayTitle, type SidebarActions } from "./Sidebar.tsx";

const COLLAPSED_KEY = "workflow-canvas.sidebar-collapsed";

function idFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("w");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** Sidebar of workflows beside the open workflow's canvas. */
export function Shell() {
  const [library, setLibrary] = useState<Library | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(idFromUrl);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<EditorHandle>(null);

  const refresh = useCallback(async () => {
    const next = await fetchLibrary();
    setLibrary(next);
    return next;
  }, []);

  /** Open a workflow and record it in the address bar (for Back and bookmarks). */
  const open = useCallback((id: string, replace = false) => {
    setCurrentId(id);
    const url = `?w=${encodeURIComponent(id)}`;
    if (replace) window.history.replaceState(null, "", url);
    else if (idFromUrl() !== id) window.history.pushState(null, "", url);
  }, []);

  // First load: open the workflow in the address, else the first in the
  // sidebar, else start one so there is always a canvas to draw on.
  useEffect(() => {
    void (async () => {
      try {
        const loaded = await refresh();
        if (idFromUrl()) return;
        const first = loaded.workflows.find((w) => w.projectId !== null) ?? loaded.workflows[0];
        if (first) {
          open(first.id, true);
        } else {
          const created = await createWorkflow("Untitled workflow");
          await refresh();
          open(created.id, true);
        }
      } catch (err) {
        setError(`Could not load your workflows: ${messageOf(err)}`);
      }
    })();
  }, [refresh, open]);

  useEffect(() => {
    const onPop = () => setCurrentId(idFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(timer);
  }, [error]);

  const toggle = () => {
    setCollapsed((was) => {
      localStorage.setItem(COLLAPSED_KEY, was ? "0" : "1");
      return !was;
    });
  };

  /** Run a sidebar action; on failure, show why and resync with the server. */
  const attempt = (work: () => Promise<void>) => {
    void work().catch(async (err: unknown) => {
      setError(messageOf(err));
      await refresh().catch(() => undefined);
    });
  };

  const onTitleChange = useCallback((id: string, title: string) => {
    setLibrary((lib) =>
      lib ? { ...lib, workflows: lib.workflows.map((w) => (w.id === id ? { ...w, title } : w)) } : lib,
    );
  }, []);

  const actions: SidebarActions = {
    open: (id) => open(id),
    newWorkflow: (projectId) =>
      attempt(async () => {
        const created = await createWorkflow("Untitled workflow", projectId);
        await refresh();
        open(created.id);
      }),
    newProject: (title) =>
      attempt(async () => {
        await createProject(title);
        await refresh();
      }),
    renameProject: (id, title) =>
      attempt(async () => {
        await renameProject(id, title);
        await refresh();
      }),
    renameWorkflow: (id, title) =>
      attempt(async () => {
        if (id === currentId && editor.current) {
          // The open canvas owns this workflow's revision, so rename through it.
          editor.current.rename(title);
          onTitleChange(id, title);
          return;
        }
        const doc = await loadWorkflow(id);
        await saveWorkflow({ ...doc, title });
        await refresh();
      }),
    duplicate: (id) =>
      attempt(async () => {
        // Copy what is on screen, not an older saved version.
        if (id === currentId) await editor.current?.settle();
        const copy = await duplicateWorkflow(id);
        await refresh();
        open(copy.id);
      }),
    remove: (id, title) =>
      attempt(async () => {
        if (!window.confirm(`Delete "${displayTitle(title)}"? This cannot be undone.`)) return;
        await deleteWorkflow(id);
        const next = await refresh();
        if (id !== currentId) return;
        const fallback = next.workflows[0];
        if (fallback) {
          open(fallback.id, true);
        } else {
          const created = await createWorkflow("Untitled workflow");
          await refresh();
          open(created.id, true);
        }
      }),
    move: (id, projectId, index) =>
      attempt(async () => {
        setLibrary(await moveWorkflow(id, projectId, index));
      }),
  };

  return (
    <div className="shell">
      {library && (
        <Sidebar library={library} currentId={currentId} collapsed={collapsed} onToggle={toggle} actions={actions} />
      )}
      <div className="shell__main">
        {error && (
          <div className="banner banner--warn" role="alert">
            {error}
          </div>
        )}
        {currentId ? (
          <WorkflowEditor key={currentId} ref={editor} workflowId={currentId} onTitleChange={onTitleChange} />
        ) : (
          <div className="screen-message">Loading…</div>
        )}
      </div>
    </div>
  );
}
