import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { setupProgress, type Readiness, type WorkflowNode } from "../../src/graph/types.ts";
import { KIND_LABEL, READINESS_LABEL } from "./cards.ts";

export type CardData = { card: WorkflowNode };
export type CardFlowNode = Node<CardData, "card">;

const MAX_OWNER_LINES = 3;

/**
 * One workflow step. Shows what the step is, who owns which part of it, and
 * how much of its setup checklist is done. Every value renders as React text,
 * so stored content cannot inject markup.
 */
export function CardNode({ data, selected }: NodeProps<CardFlowNode>) {
  const { card } = data;
  const { done, total } = setupProgress(card);

  return (
    <div className={`card card--${card.type}${selected ? " card--selected" : ""}`}>
      <Handle type="target" position={Position.Left} className="card__handle" />
      <header className="card__head">
        <span className="card__kind">{KIND_LABEL[card.type]}</span>
        <ReadinessPill readiness={card.readiness} />
      </header>
      <div className="card__title">{card.title.trim() === "" ? "Untitled step" : card.title}</div>
      {card.description.trim() !== "" && <p className="card__desc">{card.description}</p>}

      {card.type !== "note" && (
        <div className="card__owners">
          <OwnerColumn heading="Agent owns" items={card.proposal.agentOwns} />
          <OwnerColumn heading="You own" items={card.proposal.youOwn} />
        </div>
      )}

      {card.type !== "note" && (
        <footer className="card__setup" title={`${done} of ${total} setup checks done`}>
          <span className="card__setup-label">Setup</span>
          <span className="card__bar">
            <span
              className="card__bar-fill"
              style={{ width: total === 0 ? "0%" : `${Math.round((done / total) * 100)}%` }}
            />
          </span>
          <span className="card__setup-count">{total === 0 ? "none" : `${done}/${total}`}</span>
        </footer>
      )}
      <Handle type="source" position={Position.Right} className="card__handle" />
    </div>
  );
}

function ReadinessPill({ readiness }: { readiness: Readiness }) {
  return <span className={`pill pill--${readiness}`}>{READINESS_LABEL[readiness]}</span>;
}

function OwnerColumn({ heading, items }: { heading: string; items: string[] }) {
  const shown = items.slice(0, MAX_OWNER_LINES);
  const hidden = items.length - shown.length;
  return (
    <div className="owner">
      <div className="owner__heading">{heading}</div>
      {items.length === 0 ? (
        <div className="owner__empty">Not set</div>
      ) : (
        <ul className="owner__list">
          {shown.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
          {hidden > 0 && <li className="owner__more">+{hidden} more</li>}
        </ul>
      )}
    </div>
  );
}
