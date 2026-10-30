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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  readinessSummary,
  type EdgeKind,
  type NodeKind,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from "../../src/graph/types.ts";
import { validateWorkflow } from "../../src/graph/validate.ts";
import { ApiError, createWorkflow, loadWorkflow, saveWorkflow } from "./api.ts";
import { CardNode, type CardFlowNode } from "./CardNode.tsx";
import { CARD_KINDS, makeId, newCard } from "./cards.ts";

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
  requires: "#475569",
  data: "#2563eb",
  conditional: "#d97706",
  revision: "#9333ea",
};

const KIND_COLOR: Record<NodeKind, string> = {
  task: "#64748b",
  agent: "#4f46e5",
  integration: "#0d9488",
  approval: "#d97706",
  artifact: "#0284c7",
  note: "#ca8a04",
};

function toFlowNode(card: WorkflowNode): CardFlowNode {
  return { id: card.id, type: "card", position: card.position, data: { card } };
}

function toFlowEdge(edge: WorkflowEdge): FlowEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label === "" ? undefined : edge.label,
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function App() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}

function Editor() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [nodes, setNodes] = useState<CardFlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "saved" });
  const [notice, setNotice] = useState<string | null>(null);
  const [changeCount, setChangeCount] = useState(0);
  const flow = useReactFlow();

  // Saves read the newest canvas through this ref, not a stale closure.
  const latest = useRef({ meta, nodes, edges });
  latest.current = { meta, nodes, edges };
  const saving = useRef(false);
  const pending = useRef(false);
  const blocked = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        let id = new URLSearchParams(window.location.search).get("w");
        if (!id) {
          // No list screen yet: a fresh visit starts a workflow, and its
          // address (with ?w=) is what you bookmark to come back to it.
          id = (await createWorkflow("Untitled workflow")).id;
          window.history.replaceState(null, "", `?w=${encodeURIComponent(id)}`);
        }
        const { nodes: loadedNodes, edges: loadedEdges, ...rest } = await loadWorkflow(id);
        setMeta(rest);
        setNodes(loadedNodes.map(toFlowNode));
        setEdges(loadedEdges.map(toFlowEdge));
      } catch (error) {
        setLoadError(
          error instanceof ApiError && error.status === 404
            ? "This workflow does not exist."
            : `Could not load the workflow: ${messageOf(error)}`,
        );
      }
    })();
  }, []);

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
      const offset = (latest.current.nodes.length % 5) * 28;
      const card = newCard(kind, {
        x: Math.round(center.x - 130 + offset),
        y: Math.round(center.y - 90 + offset),
      });
      setNodes((current) => [
        ...current.map((node) => (node.selected ? { ...node, selected: false } : node)),
        { ...toFlowNode(card), selected: true },
      ]);
      markDirty();
    },
    [flow, markDirty],
  );

  const renameWorkflow = (title: string) => {
    setMeta((previous) => (previous ? { ...previous, title } : previous));
    markDirty();
  };

  if (loadError) {
    return (
      <div className="screen-message">
        <h1>Workflow Canvas</h1>
        <p>{loadError}</p>
        <a href="/">Start a new workflow</a>
      </div>
    );
  }
  if (!meta) return <div className="screen-message">Loading…</div>;

  const summary = readinessSummary(buildDefinition(meta, nodes, edges));

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">Workflow Canvas</span>
        <input
          className="title-input"
          aria-label="Workflow title"
          value={meta.title}
          maxLength={500}
          onChange={(event) => renameWorkflow(event.target.value)}
        />
        <div className="add-group" role="group" aria-label="Add a card">
          <span className="add-group__label">Add</span>
          {CARD_KINDS.map(({ kind, label, hint }) => (
            <button key={kind} type="button" className={`add add--${kind}`} title={hint} onClick={() => addCard(kind)}>
              {label}
            </button>
          ))}
        </div>
        <SaveIndicator state={save} onRetry={() => void flush()} />
        <a className="toolbar__new" href="/">
          New workflow
        </a>
      </header>

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
