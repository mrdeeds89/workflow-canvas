import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  deriveReadiness,
  readinessSummary,
  type EdgeKind,
  type NodeKind,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from "../../src/graph/types.ts";
import { validateWorkflow } from "../../src/graph/validate.ts";
import { ApiError, loadWorkflow, saveWorkflow } from "./api.ts";
import { CardNode, type CardFlowNode } from "./CardNode.tsx";
import { CARD_KINDS, EDGE_LABEL, makeId, newCard } from "./cards.ts";
import { BriefPanel } from "./BriefPanel.tsx";
import { CardDetails, EdgeDetails } from "./DetailsPanel.tsx";

type Meta = Omit<WorkflowDefinition, "nodes" | "edges">;
type FlowEdge = Edge<{ edge: WorkflowEdge }>;

type SaveState =
  | { kind: "saved" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "conflict" }
  | { kind: "invalid"; message: string }
  | { kind: "error"; message: string };

const nodeTypes = { card: CardNode };
const AUTOSAVE_MS = 600;
const NOTICE_MS = 6000;

const EDGE_COLOR: Record<EdgeKind, string> = {
  requires: "var(--edge-requires)",
  data: "var(--edge-data)",
  conditional: "var(--edge-conditional)",
  revision: "var(--edge-revision)",
};

const KIND_COLOR: Record<NodeKind, string> = {
  task: "var(--kind-task)",
  agent: "var(--kind-agent)",
  integration: "var(--kind-integration)",
  approval: "var(--kind-approval)",
  artifact: "var(--kind-artifact)",
  note: "var(--kind-note)",
};

function toFlowNode(card: WorkflowNode): CardFlowNode {
  return { id: card.id, type: "card", position: card.position, data: { card } };
}

function toFlowEdge(edge: WorkflowEdge): FlowEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: `${EDGE_LABEL[edge.type]}${edge.label ? `: ${edge.label}` : ""}${edge.inferred ? " (inferred)" : ""}`,
    className: `edge edge--${edge.type}${edge.inferred ? " edge--inferred" : ""}`,
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: EDGE_COLOR[edge.type] },
    data: { edge },
  };
}

/** The document to save, rebuilt from what is on the canvas. */
function buildDefinition(meta: Meta, nodes: CardFlowNode[], edges: FlowEdge[]): WorkflowDefinition {
  return {
    ...meta,
    nodes: nodes.map((node) => ({
      ...node.data.card,
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
    })),
    edges: edges.flatMap((edge) => (edge.data ? [edge.data.edge] : [])),
  };
}

const CARD_W = 268 + 32;
const CARD_H = 200 + 32;

/**
 * The nearest grid slot to `start` that no existing card covers, searching
 * outward ring by ring, so a new card never lands on top of another.
 */
function freeSpot(start: { x: number; y: number }, nodes: CardFlowNode[]): { x: number; y: number } {
  const covered = (x: number, y: number) =>
    nodes.some((node) => {
      const width = (node.measured?.width ?? 268) + 32;
      const height = (node.measured?.height ?? 200) + 32;
      return x < node.position.x + width && x + CARD_W > node.position.x && y < node.position.y + height && y + CARD_H > node.position.y;
    });
  for (let ring = 0; ring <= 8; ring += 1) {
    for (let dy = -ring; dy <= ring; dy += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = Math.round(start.x + dx * CARD_W);
        const y = Math.round(start.y + dy * CARD_H);
        if (!covered(x, y)) return { x, y };
      }
    }
  }
  return start;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** What the shell can ask of the open editor. */
export type EditorHandle = {
  /** Resolve once every edit made so far is saved (or saving has stopped). */
  settle(): Promise<void>;
  /** Rename the open workflow through the editor, so its revision stays in step. */
  rename(title: string): void;
};

type EditorProps = {
  workflowId: string;
  onTitleChange: (id: string, title: string) => void;
  ref?: Ref<EditorHandle>;
};

/** One workflow's canvas. Keyed by workflow id, so switching starts fresh. */
export function WorkflowEditor(props: EditorProps) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

function Editor({ workflowId, onTitleChange, ref }: EditorProps) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [nodes, setNodes] = useState<CardFlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "saved" });
  const [notice, setNotice] = useState<string | null>(null);
  const [changeCount, setChangeCount] = useState(0);
  const [briefOpen, setBriefOpen] = useState(true);
  const flow = useReactFlow();

  // Saves read the newest canvas through this ref, not a stale closure.
  const latest = useRef({ meta, nodes, edges });
  latest.current = { meta, nodes, edges };
  const saving = useRef(false);
  const pending = useRef(false);
  const blocked = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { nodes: loadedNodes, edges: loadedEdges, ...rest } = await loadWorkflow(workflowId);
        if (cancelled) return;
        setMeta(rest);
        setNodes(loadedNodes.map(toFlowNode));
        setEdges(loadedEdges.map(toFlowEdge));
      } catch (error) {
        if (cancelled) return;
        setLoadError(
          error instanceof ApiError && error.status === 404
            ? "This workflow does not exist. It may have been deleted."
            : `Could not load the workflow: ${messageOf(error)}`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  useEffect(() => {
    if (meta) document.title = `${meta.title.trim() || "Untitled workflow"} · Workflow Canvas`;
  }, [meta]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const markDirty = useCallback(() => {
    if (blocked.current) return;
    dirty.current = true;
    setSave({ kind: "dirty" });
    setChangeCount((count) => count + 1);
  }, []);

  const flush = useCallback(async () => {
    if (blocked.current) return;
    if (saving.current) {
      pending.current = true;
      return;
    }
    const { meta: currentMeta, nodes: currentNodes, edges: currentEdges } = latest.current;
    if (!currentMeta) return;

    saving.current = true;
    dirty.current = false;
    setSave({ kind: "saving" });
    try {
      const saved = await saveWorkflow(buildDefinition(currentMeta, currentNodes, currentEdges));
      // The next save must expect this revision even before React re-renders.
      if (latest.current.meta) latest.current.meta = { ...latest.current.meta, revision: saved.revision };
      setMeta((previous) => (previous ? { ...previous, revision: saved.revision } : previous));

      // The server derives readiness from each checklist; show what it stored.
      const derived = new Map(saved.nodes.map((card) => [card.id, card.readiness]));
      setNodes((current) =>
        current.map((node) => {
          const readiness = derived.get(node.id);
          return readiness && readiness !== node.data.card.readiness
            ? { ...node, data: { card: { ...node.data.card, readiness } } }
            : node;
        }),
      );
      setSave(pending.current ? { kind: "dirty" } : { kind: "saved" });
    } catch (error) {
      // Unsaved again: a later flush (or leaving the workflow) will retry.
      if (!(error instanceof ApiError && error.status === 409)) dirty.current = true;
      if (error instanceof ApiError && error.status === 409) {
        blocked.current = true;
        setSave({ kind: "conflict" });
      } else if (error instanceof ApiError && error.status === 422) {
        setSave({ kind: "invalid", message: error.issues[0]?.message ?? error.message });
      } else {
        setSave({ kind: "error", message: messageOf(error) });
      }
    } finally {
      saving.current = false;
      if (pending.current && !blocked.current) {
        pending.current = false;
        void flush();
      }
    }
  }, []);

  useEffect(() => {
    if (changeCount === 0) return;
    const timer = setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [changeCount, flush]);

  // Leaving this workflow (switching in the sidebar) saves what is pending.
  useEffect(
    () => () => {
      if (dirty.current && !blocked.current) void flush();
    },
    [flush],
  );

  useImperativeHandle(
    ref,
    () => ({
      async settle() {
        if (dirty.current && !blocked.current) await flush();
        while ((saving.current || pending.current) && !blocked.current) {
          await new Promise((wait) => setTimeout(wait, 50));
        }
      },
      rename(title: string) {
        setMeta((previous) => (previous ? { ...previous, title } : previous));
        markDirty();
      },
    }),
    [flush, markDirty],
  );

  // Warn before closing the tab while edits are still on their way.
  useEffect(() => {
    if (save.kind === "saved" || save.kind === "conflict") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save.kind]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CardFlowNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
      const persistent = changes.some(
        (change) => (change.type === "position" && change.dragging !== true) || change.type === "remove",
      );
      if (persistent) markDirty();
    },
    [markDirty],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      setEdges((current) => applyEdgeChanges(changes, current));
      if (changes.some((change) => change.type === "remove")) markDirty();
    },
    [markDirty],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const { meta: currentMeta, nodes: currentNodes, edges: currentEdges } = latest.current;
      if (!currentMeta) return;
      if (currentEdges.some((edge) => edge.source === connection.source && edge.target === connection.target)) {
        setNotice("Those two cards are already connected.");
        return;
      }
      const edge: WorkflowEdge = {
        id: makeId("edge"),
        source: connection.source,
        target: connection.target,
        type: "requires",
        label: "",
        inferred: false,
      };
      // Same validator as the server, so a loop is refused before it is drawn.
      const candidate = buildDefinition(currentMeta, currentNodes, currentEdges);
      const check = validateWorkflow({ ...candidate, edges: [...candidate.edges, edge] });
      if (!check.ok && check.issues.some((issue) => issue.code === "dependency_cycle")) {
        setNotice("That arrow would make a loop of steps that each wait on the other, so it was not added.");
        return;
      }
      setEdges((current) => [...current, toFlowEdge(edge)]);
      markDirty();
    },
    [markDirty],
  );

  const addCard = useCallback(
    (kind: NodeKind) => {
      const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      const card = newCard(kind, freeSpot({ x: center.x - 134, y: center.y - 100 }, latest.current.nodes));
      setNodes((current) => [
        ...current.map((node) => (node.selected ? { ...node, selected: false } : node)),
        { ...toFlowNode(card), selected: true },
      ]);
      setEdges((current) => current.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)));
      markDirty();
    },
    [flow, markDirty],
  );

  /** Edit one card from the details panel; readiness is re-derived like the server does. */
  const updateCard = useCallback(
    (id: string, change: (card: WorkflowNode) => WorkflowNode) => {
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== id) return node;
          const next = change(node.data.card);
          return { ...node, data: { card: { ...next, readiness: deriveReadiness(next.readiness, next.setup) } } };
        }),
      );
      markDirty();
    },
    [markDirty],
  );

  /** Edit one arrow; refuses a kind change that would create a dependency loop. */
  const updateEdge = useCallback(
    (next: WorkflowEdge) => {
      const { meta: currentMeta, nodes: currentNodes, edges: currentEdges } = latest.current;
      if (!currentMeta) return;
      const candidate = buildDefinition(currentMeta, currentNodes, currentEdges);
      const check = validateWorkflow({
        ...candidate,
        edges: candidate.edges.map((edge) => (edge.id === next.id ? next : edge)),
      });
      if (!check.ok && check.issues.some((issue) => issue.code === "dependency_cycle")) {
        setNotice("Making this arrow a dependency would create a loop, so its kind was not changed.");
        return;
      }
      setEdges((current) =>
        current.map((edge) => (edge.id === next.id ? { ...toFlowEdge(next), selected: edge.selected } : edge)),
      );
      markDirty();
    },
    [markDirty],
  );

  const closeDetails = useCallback(() => {
    setNodes((current) => current.map((node) => (node.selected ? { ...node, selected: false } : node)));
    setEdges((current) => current.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)));
  }, []);

  const renameWorkflow = (title: string) => {
    setMeta((previous) => (previous ? { ...previous, title } : previous));
    onTitleChange(workflowId, title);
    markDirty();
  };

  const setBrief = (brief: string) => {
    setMeta((previous) => (previous ? { ...previous, brief } : previous));
    if (latest.current.meta) latest.current.meta = { ...latest.current.meta, brief };
    markDirty();
  };

  if (loadError) {
    return (
      <div className="screen-message">
        <h1>Can't open this workflow</h1>
        <p>{loadError}</p>
        <p>Pick another from the sidebar, or start a new one.</p>
      </div>
    );
  }
  if (!meta) return <div className="screen-message">Loading…</div>;

  const summary = readinessSummary(buildDefinition(meta, nodes, edges));
  // The panel follows a single selection: one card, or one arrow.
  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedEdges = edges.filter((edge) => edge.selected);
  const selectedCard = selectedNodes.length === 1 && selectedEdges.length === 0 ? selectedNodes[0] : undefined;
  const selectedEdge = selectedEdges.length === 1 && selectedNodes.length === 0 ? selectedEdges[0] : undefined;
  const titleOf = (id: string) => nodes.find((node) => node.id === id)?.data.card.title ?? "";

  return (
    <div className="app">
      <header className="toolbar">
        <input
          className="title-input"
          aria-label="Workflow title"
          value={meta.title}
          maxLength={500}
          onChange={(event) => renameWorkflow(event.target.value)}
        />
        <button
          type="button"
          className="brief-toggle"
          aria-expanded={briefOpen}
          onClick={() => setBriefOpen((open) => !open)}
        >
          Workflow brief
        </button>
        <div className="add-group" role="group" aria-label="Add a card">
          <span className="add-group__label">Add</span>
          {CARD_KINDS.map(({ kind, label, hint }) => (
            <button key={kind} type="button" className={`add add--${kind}`} title={hint} onClick={() => addCard(kind)}>
              {label}
            </button>
          ))}
        </div>
        <SaveIndicator state={save} onRetry={() => void flush()} />
      </header>
      {briefOpen && <BriefPanel value={meta.brief} onChange={setBrief} onClose={() => setBriefOpen(false)} />}

      {save.kind === "conflict" && (
        <div className="banner banner--warn" role="alert">
          This workflow was changed somewhere else, so edits made here since then were not saved.
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
      {notice && (
        <div className="banner banner--info" role="status">
          {notice}
        </div>
      )}

      <div className="workspace">
      <main className="canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={(connection) => connection.source !== connection.target}
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={2}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node: Node) => KIND_COLOR[(node as CardFlowNode).data.card.type]}
          />
          {nodes.length === 0 && (
            <Panel position="top-center">
              <div className="empty-hint">
                Add a card from the toolbar. Drag from a card's right edge onto another card to connect them.
              </div>
            </Panel>
          )}
        </ReactFlow>
      </main>
      {selectedCard && (
        <CardDetails
          key={selectedCard.id}
          card={selectedCard.data.card}
          onChange={(change) => updateCard(selectedCard.id, change)}
          onDelete={() => void flow.deleteElements({ nodes: [{ id: selectedCard.id }] })}
          onClose={closeDetails}
        />
      )}
      {selectedEdge?.data && (
        <EdgeDetails
          key={selectedEdge.id}
          edge={selectedEdge.data.edge}
          sourceTitle={titleOf(selectedEdge.source)}
          targetTitle={titleOf(selectedEdge.target)}
          onChange={updateEdge}
          onDelete={() => void flow.deleteElements({ edges: [{ id: selectedEdge.id }] })}
          onClose={closeDetails}
        />
      )}
      </div>

      <footer className="statusbar">
        <span>
          {summary.cards} {summary.cards === 1 ? "card" : "cards"} · {summary.proposed} proposed ·{" "}
          {summary.not_configured} not configured · {summary.configured} configured
        </span>
        <span>
          {edges.length} {edges.length === 1 ? "connection" : "connections"}
        </span>
        <span className="statusbar__boundary">Design only: nothing on this canvas runs.</span>
      </footer>
    </div>
  );
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  switch (state.kind) {
    case "saved":
      return <span className="save save--ok">All changes saved</span>;
    case "dirty":
      return <span className="save">Unsaved changes</span>;
    case "saving":
      return <span className="save">Saving…</span>;
    case "conflict":
      return <span className="save save--bad">Not saved: changed elsewhere</span>;
    case "invalid":
      return (
        <span className="save save--bad" title={state.message}>
          Not saved: {state.message}
        </span>
      );
    case "error":
      return (
        <span className="save save--bad" title={state.message}>
          Save failed
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </span>
      );
  }
}
