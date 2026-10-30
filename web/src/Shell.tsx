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

import { ThemeSelector } from "./ThemeSelector.tsx";

const COLLAPSED_KEY = "workflow-canvas.sidebar-collapsed";

function idFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("w");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

type UrlMode = "push" | "replace" | "keep";

function writeUrl(id: string, mode: UrlMode) {
  if (mode === "keep") return;
  const url = `?w=${encodeURIComponent(id)}`;
  if (mode === "replace") window.history.replaceState(null, "", url);
  else if (idFromUrl() !== id) window.history.pushState(null, "", url);
}

/** Let the next editor mount before a queued switch settles it. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Sidebar of workflows beside the open workflow's canvas. */
export function Shell() {
  const [library, setLibrary] = useState<Library | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(idFromUrl);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
  });
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<EditorHandle>(null);
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  // Switches run one at a time. A click during a save waits for that save,
  // so a fast return cannot load a copy that the save has not written yet.
  const chain = useRef(Promise.resolve());

  const refresh = useCallback(async () => {
    const next = await fetchLibrary();
    setLibrary(next);
    return next;
  }, []);

  const go = useCallback((id: string, mode: UrlMode = "push") => {
    const run = chain.current.then(async () => {
      if (id !== currentIdRef.current) {
        const saved = await editor.current?.settle();
        if (saved === false) return;
      }
      if (id === currentIdRef.current) {
        writeUrl(id, mode);
        return;
      }
      currentIdRef.current = id;
      setCurrentId(id);
      writeUrl(id, mode);
      await nextFrame();
    });
    chain.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
          void go(first.id, "replace");
        } else {
          const created = await createWorkflow("Untitled workflow");
          await refresh();
          void go(created.id, "replace");
        }
      } catch (err) {
        setError(`Could not load your workflows: ${messageOf(err)}`);
      }
    })();
  }, [refresh, go]);

  useEffect(() => {
    const onPop = () => {
      const id = idFromUrl();
      if (id) void go(id, "keep");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [go]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(timer);
  }, [error]);

  const toggle = () => {
    setCollapsed((was) => {
      try { localStorage.setItem(COLLAPSED_KEY, was ? "0" : "1"); } catch { /* Storage is optional. */ }
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
    open: (id) => {
      void go(id);
    },
    newWorkflow: (projectId) =>
      attempt(async () => {
        const created = await createWorkflow("Untitled workflow", projectId);
        await refresh();
        await go(created.id);
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
        if (id === currentId) {
          const saved = await editor.current?.settle();
          if (saved === false) return;
        }
        const copy = await duplicateWorkflow(id);
        await refresh();
        await go(copy.id);
      }),
    remove: (id, title) =>
      attempt(async () => {
        if (!window.confirm(`Delete "${displayTitle(title)}"? This cannot be undone.`)) return;
        const open = id === currentIdRef.current;
        // Hold writes for the attempt only. Retire after the row is gone, so a
        // failed delete can still save, and a late unmount cannot write it back.
        if (open) editor.current?.holdWrites();
        try {
          await deleteWorkflow(id);
        } catch (error) {
          if (open && currentIdRef.current === id) editor.current?.releaseWrites();
          throw error;
        }
        if (open && currentIdRef.current === id) editor.current?.discard();
        const next = await refresh();
        if (id !== currentIdRef.current && id !== currentId) return;
        const fallback = next.workflows[0];
        if (fallback) {
          await go(fallback.id, "replace");
        } else {
          const created = await createWorkflow("Untitled workflow");
          await refresh();
          await go(created.id, "replace");
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
        <ThemeSelector />
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
