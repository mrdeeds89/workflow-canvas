import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { Library, ProjectSummary, WorkflowSummary } from "./api.ts";

const DRAG_TYPE = "application/x-workflow-canvas-workflow";

export type SidebarActions = {
  open(id: string): void;
  newWorkflow(projectId: string | null): void;
  newProject(title: string): void;
  renameProject(id: string, title: string): void;
  renameWorkflow(id: string, title: string): void;
  duplicate(id: string): void;
  remove(id: string, title: string): void;
  /** Place a workflow in a list (null = Unfiled) at an index in that list. */
  move(id: string, projectId: string | null, index: number): void;
};

type Props = {
  library: Library;
  currentId: string | null;
  collapsed: boolean;
  onToggle(): void;
  actions: SidebarActions;
};

type Section = { key: string; projectId: string | null; title: string; project?: ProjectSummary; items: WorkflowSummary[] };

/** Projects in creation order, then Unfiled; each list in its manual order. */
function sections(library: Library): Section[] {
  const out: Section[] = library.projects.map((project) => ({
    key: project.id,
    projectId: project.id,
    title: project.title,
    project,
    items: [],
  }));
  const unfiled: Section = { key: "unfiled", projectId: null, title: "Unfiled", items: [] };
  const byId = new Map(out.map((section) => [section.projectId, section]));
  for (const workflow of library.workflows) {
    (byId.get(workflow.projectId) ?? unfiled).items.push(workflow);
  }
  return [...out, unfiled];
}

export const displayTitle = (title: string) => (title.trim() === "" ? "Untitled workflow" : title);

export function Sidebar({ library, currentId, collapsed, onToggle, actions }: Props) {
  const [addingProject, setAddingProject] = useState(false);
  const [drop, setDrop] = useState<{ list: string; index: number } | null>(null);
  const dragging = useRef<string | null>(null);

  if (collapsed) {
    return (
      <nav className="sidebar sidebar--collapsed" aria-label="Workflows">
        <button type="button" className="icon-btn" title="Show sidebar" aria-label="Show sidebar" onClick={onToggle}>
          »
        </button>
        <button
          type="button"
          className="icon-btn sidebar__rail-new"
          title="New workflow"
          aria-label="New workflow"
          onClick={() => actions.newWorkflow(null)}
        >
          +
        </button>
      </nav>
    );
  }

  const all = sections(library);

  const endDrag = () => {
    dragging.current = null;
    setDrop(null);
  };

  /** Drop position inside a list, excluding the dragged item itself. */
  const indexFor = (section: Section, overId: string | null, after: boolean) => {
    const ids = section.items.map((item) => item.id).filter((id) => id !== dragging.current);
    if (overId === null) return ids.length;
    const at = ids.indexOf(overId);
    return at === -1 ? ids.length : at + (after ? 1 : 0);
  };

  const onDrop = (event: DragEvent, section: Section, index: number) => {
    event.preventDefault();
    const id = event.dataTransfer.getData(DRAG_TYPE) || dragging.current;
    endDrag();
    if (id) actions.move(id, section.projectId, index);
  };

  return (
    <nav className="sidebar" aria-label="Workflows">
      <div className="sidebar__top">
        <span className="brand">Workflow Canvas</span>
        <button type="button" className="icon-btn" title="Hide sidebar" aria-label="Hide sidebar" onClick={onToggle}>
          «
        </button>
      </div>
      <button type="button" className="new-workflow" onClick={() => actions.newWorkflow(null)}>
        + New workflow
      </button>

      <div className="sidebar__heading">
        <span>Projects</span>
        <button
          type="button"
          className="icon-btn"
          title="New project"
          aria-label="New project"
          onClick={() => setAddingProject(true)}
        >
          +
        </button>
      </div>
      {addingProject && (
        <InlineName
          placeholder="Project name"
          initial=""
          onDone={(title) => {
            setAddingProject(false);
            if (title !== null && title.trim() !== "") actions.newProject(title.trim());
          }}
        />
      )}

      <div className="sidebar__lists">
        {all.map((section) => (
          <div
            key={section.key}
            className={`list${section.projectId === null ? " list--unfiled" : ""}`}
            onDragOver={(event) => {
              if (!dragging.current) return;
              event.preventDefault();
              if (event.target === event.currentTarget) setDrop({ list: section.key, index: indexFor(section, null, true) });
            }}
            onDrop={(event) => onDrop(event, section, drop?.list === section.key ? drop.index : indexFor(section, null, true))}
          >
            <ListHeader section={section} actions={actions} />
            {section.items.length === 0 && (
              <div className="list__empty">{section.projectId === null ? "Nothing unfiled" : "Empty. Drag workflows here."}</div>
            )}
            {section.items.map((item) => (
              <WorkflowRow
                key={item.id}
                item={item}
                active={item.id === currentId}
                projects={library.projects}
                actions={actions}
                dropBefore={drop?.list === section.key && drop.index === indexFor(section, item.id, false) && dragging.current !== item.id}
                onDragStart={(event) => {
                  dragging.current = item.id;
                  event.dataTransfer.setData(DRAG_TYPE, item.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={endDrag}
                onDragOver={(event) => {
                  if (!dragging.current) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const box = event.currentTarget.getBoundingClientRect();
                  const after = event.clientY > box.top + box.height / 2;
                  setDrop({ list: section.key, index: indexFor(section, item.id, after) });
                }}
                onDrop={(event) => {
                  event.stopPropagation();
                  const box = event.currentTarget.getBoundingClientRect();
                  const after = event.clientY > box.top + box.height / 2;
                  onDrop(event, section, indexFor(section, item.id, after));
                }}
              />
            ))}
            {drop?.list === section.key && drop.index === section.items.filter((i) => i.id !== dragging.current).length && (
              <div className="drop-line" />
            )}
          </div>
        ))}
      </div>
    </nav>
  );
}

function ListHeader({ section, actions }: { section: Section; actions: SidebarActions }) {
  const [renaming, setRenaming] = useState(false);
  const { project } = section;
  return (
    <div className="list__header">
      {renaming && project ? (
        <InlineName
          initial={project.title}
          placeholder="Project name"
          onDone={(title) => {
            setRenaming(false);
            if (title !== null && title.trim() !== "" && title.trim() !== project.title) {
              actions.renameProject(project.id, title.trim());
            }
          }}
        />
      ) : (
        <>
          <span
            className="list__title"
            title={project ? "Double-click to rename" : undefined}
            onDoubleClick={() => project && setRenaming(true)}
          >
            {section.title}
          </span>
          {project && (
            <button
              type="button"
              className="icon-btn icon-btn--small"
              title="Rename project"
              aria-label={`Rename project ${project.title}`}
              onClick={() => setRenaming(true)}
            >
              ✎
            </button>
          )}
          <button
            type="button"
            className="icon-btn icon-btn--small"
            title={`New workflow in ${section.title}`}
            aria-label={`New workflow in ${section.title}`}
            onClick={() => actions.newWorkflow(section.projectId)}
          >
            +
          </button>
        </>
      )}
    </div>
  );
}

type RowProps = {
  item: WorkflowSummary;
  active: boolean;
  projects: ProjectSummary[];
  actions: SidebarActions;
  dropBefore: boolean;
  onDragStart(event: DragEvent<HTMLDivElement>): void;
  onDragEnd(): void;
  onDragOver(event: DragEvent<HTMLDivElement>): void;
  onDrop(event: DragEvent<HTMLDivElement>): void;
};

function WorkflowRow({ item, active, projects, actions, dropBefore, ...drag }: RowProps) {
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<"main" | "move" | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const escape = (event: globalThis.KeyboardEvent) => event.key === "Escape" && setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);

  const run = (action: () => void) => {
    setMenu(null);
    action();
  };

  return (
    <>
      {dropBefore && <div className="drop-line" />}
      <div
        className={`row-item${active ? " row-item--active" : ""}`}
        draggable={!renaming}
        onDragStart={drag.onDragStart}
        onDragEnd={drag.onDragEnd}
        onDragOver={drag.onDragOver}
        onDrop={drag.onDrop}
      >
        {renaming ? (
          <InlineName
            initial={item.title}
            placeholder="Workflow name"
            onDone={(title) => {
              setRenaming(false);
              if (title !== null && title !== item.title) actions.renameWorkflow(item.id, title);
            }}
          />
        ) : (
          <button
            type="button"
            className="row-item__open"
            title={displayTitle(item.title)}
            onClick={() => actions.open(item.id)}
            onDoubleClick={() => setRenaming(true)}
          >
            {displayTitle(item.title)}
          </button>
        )}
        {!renaming && (
          <div className="menu-anchor" ref={menuRef}>
            <button
              type="button"
              className="icon-btn icon-btn--small row-item__more"
              aria-label={`Actions for ${displayTitle(item.title)}`}
              aria-expanded={menu !== null}
              onClick={() => setMenu(menu ? null : "main")}
            >
              ⋯
            </button>
            {menu === "main" && (
              <div className="menu" role="menu">
                <button type="button" role="menuitem" onClick={() => run(() => setRenaming(true))}>
                  Rename
                </button>
                <button type="button" role="menuitem" onClick={() => run(() => actions.duplicate(item.id))}>
                  Duplicate
                </button>
                <button type="button" role="menuitem" onClick={() => setMenu("move")}>
                  Move to… ›
                </button>
                <div className="menu__sep" />
                <button
                  type="button"
                  role="menuitem"
                  className="menu__danger"
                  onClick={() => run(() => actions.remove(item.id, item.title))}
                >
                  Delete…
                </button>
              </div>
            )}
            {menu === "move" && (
              <div className="menu" role="menu" aria-label="Move to">
                <div className="menu__label">Move to</div>
                {[...projects.map((p) => ({ id: p.id as string | null, title: p.title })), { id: null, title: "Unfiled" }].map(
                  (target) => (
                    <button
                      key={target.id ?? "unfiled"}
                      type="button"
                      role="menuitem"
                      disabled={target.id === item.projectId}
                      onClick={() => run(() => actions.move(item.id, target.id, Number.MAX_SAFE_INTEGER))}
                    >
                      {target.title}
                      {target.id === item.projectId ? " (here)" : ""}
                    </button>
                  ),
                )}
                <div className="menu__sep" />
                <button type="button" role="menuitem" onClick={() => setMenu("main")}>
                  ‹ Back
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** A small text box that commits on Enter or blur and cancels on Escape. */
function InlineName({
  initial,
  placeholder,
  onDone,
}: {
  initial: string;
  placeholder: string;
  onDone(title: string | null): void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") finish(value);
    if (event.key === "Escape") finish(null);
  };
  return (
    <input
      className="input inline-name"
      value={value}
      placeholder={placeholder}
      maxLength={500}
      autoFocus
      onFocus={(event) => event.target.select()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(value)}
    />
  );
}
