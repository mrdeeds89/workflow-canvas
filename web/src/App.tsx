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
import { HarnessPanel } from "./HarnessPanel.tsx";
import { RunPanel } from "./RunPanel.tsx";
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
  /** Resolve once every edit made so far is saved. False means the write failed and the editor must stay open. */
  settle(): Promise<boolean>;
  /** Rename the open workflow through the editor, so its revision stays in step. */
  rename(title: string): void;
  /** Drop unsaved edits. Call only after this workflow has been deleted. */
  discard(): void;
  /** Pause writes while a delete of this workflow is attempted. Does not drop edits. */
  holdWrites(): void;
  /** Resume writes after that delete failed, including an edit already pending. */
  releaseWrites(): void;
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
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const flow = useReactFlow();

  // Saves read the newest canvas through this ref, not a stale closure.
  const latest = useRef({ meta, nodes, edges });
  latest.current = { meta, nodes, edges };
  const saving = useRef(false);
  const blocked = useRef(false);
  const dirty = useRef(false);
  // Set when this workflow is deleted, so a late save cannot write it back.
  const retired = useRef(false);
  // Set only while a delete is in flight. A failed delete clears this and saves again.
  const holding = useRef(false);
  // Kept beside React state so a save that finishes mid-edit still sends the
  // revision the server just stored, not the one from the previous render.
  const revision = useRef(0);
  // One save promise per editor, including edits that arrive while it is in flight.
  const inflight = useRef<Promise<boolean> | null>(null);
  // A sidebar rename that arrives before the document has loaded.
  const pendingTitle = useRef<string | null>(null);
  const loadDone = useRef<Promise<void>>(Promise.resolve());
  // Counts real edits, so a failed write can tell a newer edit from a caller
  // that only asked to wait (switching away, Retry, autosave).
  const edits = useRef(0);
  // The edit count the last write carried. Autosave skips when nothing is newer,
  // so an edit already sent by the loop is not sent again by its own timer.
  const lastSent = useRef(0);
  // The load reports the stored title without depending on the callback's identity.
  const titleChanged = useRef(onTitleChange);
  titleChanged.current = onTitleChange;

  useEffect(() => {
    let cancelled = false;
    const run = (async () => {
      try {
        const { nodes: loadedNodes, edges: loadedEdges, ...rest } = await loadWorkflow(workflowId);
        if (cancelled) return;
        // Skip only a late response for a document already on screen. The first
        // load must paint, or a rename during Loading leaves the editor blank.
        if (latest.current.meta && (dirty.current || saving.current)) return;
        const title = pendingTitle.current;
        pendingTitle.current = null;
        const next = title === null ? rest : { ...rest, title };
        revision.current = rest.revision;
        const loadedNodesFlow = loadedNodes.map(toFlowNode);
        const loadedEdgesFlow = loadedEdges.map(toFlowEdge);
        latest.current = { meta: next, nodes: loadedNodesFlow, edges: loadedEdgesFlow };
        setMeta(next);
        setNodes(loadedNodesFlow);
        setEdges(loadedEdgesFlow);
        titleChanged.current(workflowId, next.title);
        if (title !== null) {
          edits.current += 1;
          dirty.current = true;
          setSave({ kind: "dirty" });
          setChangeCount((count) => count + 1);
        }
      } catch (error) {
        if (cancelled) return;
        setLoadError(
          error instanceof ApiError && error.status === 404
            ? "This workflow does not exist. It may have been deleted."
            : `Could not load the workflow: ${messageOf(error)}`,
        );
      }
    })();
    loadDone.current = run.then(
      () => undefined,
      () => undefined,
    );
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
    edits.current += 1;
    dirty.current = true;
    setSave({ kind: "dirty" });
    setChangeCount((count) => count + 1);
  }, []);

  /**
   * Write the canvas. Edits that arrive while the write is in flight are sent
   * before this promise resolves, using the revision the server just stored.
   * A failed write stops. Retrying immediately hid the error and spun on a
   * down server. Returns false when the latest attempt failed.
   */
  const flush = useCallback(async (): Promise<boolean> => {
    if (blocked.current || retired.current || holding.current) return false;
    // Join the write in flight. An edit made meanwhile already set dirty, so
    // the loop below sends it; a caller that only waits must not add a write.
    if (saving.current) return inflight.current ?? Promise.resolve(false);

    saving.current = true;
    const run = (async (): Promise<boolean> => {
      try {
        while (!blocked.current && !retired.current && !holding.current) {
          if (!dirty.current) return true;
          const { meta: currentMeta, nodes: currentNodes, edges: currentEdges } = latest.current;
          if (!currentMeta) return false;
          dirty.current = false;
          const sentAt = edits.current;
          lastSent.current = sentAt;
          const definition = buildDefinition(currentMeta, currentNodes, currentEdges);
          definition.revision = revision.current;
          setSave({ kind: "saving" });
          try {
            const saved = await saveWorkflow(definition);
            if (retired.current) return false;
            revision.current = saved.revision;
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
          } catch (error) {
            if (retired.current) return false;
            // Still unsaved, so Retry or a later edit can try again. Not now.
            if (!(error instanceof ApiError && error.status === 409)) dirty.current = true;
            if (error instanceof ApiError && error.status === 409) {
              blocked.current = true;
              dirty.current = false;
              setSave({ kind: "conflict" });
            } else if (error instanceof ApiError && error.status === 422) {
              setSave({ kind: "invalid", message: error.issues[0]?.message ?? error.message });
            } else {
              setSave({ kind: "error", message: messageOf(error) });
            }
            // A newer edit arrived during this failed write. Send that once.
            // The same failed body must not be retried here.
            if (edits.current !== sentAt && !blocked.current && !retired.current && !holding.current) {
              setSave({ kind: "dirty" });
              continue;
            }
            return false;
          }
          // The write already landed. Do not send the next one until delete settles.
          if (holding.current) {
            if (dirty.current) setSave({ kind: "dirty" });
            else setSave({ kind: "saved" });
            return !dirty.current;
          }
          if (dirty.current) {
            setSave({ kind: "dirty" });
            continue;
          }
          setSave({ kind: "saved" });
          return true;
        }
        return false;
      } finally {
        saving.current = false;
      }
    })();

    inflight.current = run;
    try {
      return await run;
    } finally {
      if (inflight.current === run) inflight.current = null;
    }
  }, []);

  useEffect(() => {
    if (changeCount === 0) return;
    const timer = setTimeout(() => {
      // Retry and leaving still resend a failed body; the timer only sends news.
      if (edits.current !== lastSent.current) void flush();
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [changeCount, flush]);

  // Backup for a leave that did not go through the shell's settle. A deleted
  // workflow must not be written back by this.
  useEffect(
    () => () => {
      if (dirty.current && !blocked.current && !retired.current && !holding.current) void flush();
    },
    [flush],
  );

  const settleAll = useCallback(async (): Promise<boolean> => {
    if (retired.current) return true;
    if (blocked.current || holding.current) return false;
    await loadDone.current;
    if (retired.current) return true;
    if (blocked.current || holding.current) return false;
    // Include an edit that lands while the previous write is still open.
    // False means the write failed: the shell must stay here so the error
    // remains visible and a late unmount write cannot race a reload.
    while (!retired.current && !blocked.current && !holding.current && (dirty.current || saving.current)) {
      if (!latest.current.meta) return false;
      const saved = await flush();
      if (!saved) return false;
    }
    return !blocked.current && !holding.current;
  }, [flush]);

  /** Save everything, then report the revision the server holds, for a run request. */
  const settleForRun = useCallback(async (): Promise<number | null> => {
    if (retired.current) return null;
    return (await settleAll()) ? revision.current : null;
  }, [settleAll]);

  /** Select one card and bring it into view, e.g. from a run-check message. */
  const focusCard = useCallback(
    (id: string) => {
      setNodes((current) => current.map((node) => ({ ...node, selected: node.id === id })));
      setEdges((current) => current.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)));
      void flow.fitView({ nodes: [{ id }], maxZoom: 1, duration: 300 });
    },
    [flow],
  );

  useImperativeHandle(
    ref,
    () => ({
      settle: settleAll,
      rename(title: string) {
        if (!latest.current.meta) {
          pendingTitle.current = title;
          return;
        }
        setMeta((previous) => (previous ? { ...previous, title } : previous));
        latest.current.meta = { ...latest.current.meta, title };
        markDirty();
      },
      holdWrites() {
        holding.current = true;
      },
      releaseWrites() {
        holding.current = false;
        if (retired.current || blocked.current || saving.current) return;
        if (dirty.current) void flush();
      },
      discard() {
        retired.current = true;
        holding.current = false;
        dirty.current = false;
      },
    }),
    [flush, markDirty, settleAll],
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
    if (latest.current.meta) latest.current.meta = { ...latest.current.meta, title };
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
        <button
          type="button"
          className="brief-toggle"
          aria-expanded={evidenceOpen}
          onClick={() => setEvidenceOpen((open) => !open)}
        >
          Job evidence
        </button>
        <button
          type="button"
          className="brief-toggle"
          aria-expanded={runOpen}
          onClick={() => setRunOpen((open) => !open)}
        >
          What would run
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
      {evidenceOpen && <HarnessPanel workflowId={workflowId} onClose={() => setEvidenceOpen(false)} />}
      {runOpen && (
        <RunPanel
          workflowId={workflowId}
          definition={buildDefinition(meta, nodes, edges)}
          settle={settleForRun}
          onSelectCard={focusCard}
          onClose={() => setRunOpen(false)}
        />
      )}

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
