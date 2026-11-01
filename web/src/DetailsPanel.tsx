import { useEffect, useState, type ReactNode } from "react";
import {
  EXECUTOR_PATTERN,
  MAX_RUNTIME_MINUTES,
  MAX_SKILLS,
  isSkillName,
  type EdgeKind,
  type NodeKind,
  type RunSettings,
  type SetupTask,
  type WorkflowEdge,
  type WorkflowNode,
} from "../../src/graph/types.ts";
// The same link rule the server enforces, so the panel and server agree.
import { isSafeLink } from "../../src/graph/validate.ts";
import { CARD_KINDS, EDGE_LABEL, READINESS_LABEL, makeId, runsAsStep } from "./cards.ts";
import { fetchDeliveryTargets, type DeliveryTarget } from "./api.ts";

const EDGE_KINDS: readonly { kind: EdgeKind; hint: string }[] = [
  { kind: "requires", hint: "The next step waits for this one to finish." },
  { kind: "data", hint: "This step hands information to the next." },
  { kind: "conditional", hint: "Only taken when the label's condition holds." },
  { kind: "revision", hint: "Sends work back for changes. Not a dependency, so it may point backwards." },
];

// ---------------------------------------------------------------- card

type CardDetailsProps = {
  card: WorkflowNode;
  onChange: (change: (card: WorkflowNode) => WorkflowNode) => void;
  onDelete: () => void;
  onClose: () => void;
};

export function CardDetails({ card, onChange, onDelete, onClose }: CardDetailsProps) {
  const set = (patch: Partial<WorkflowNode>) => onChange((current) => ({ ...current, ...patch }));
  const isNote = card.type === "note";

  return (
    <aside className="details" aria-label="Card details">
      <PanelHeader title="Card" onClose={onClose} />

      {card.inferred && (
        <InferredNotice what="card" onConfirm={() => set({ inferred: false })} />
      )}

      <Field label="Name">
        <input
          className="input"
          value={card.title}
          maxLength={500}
          onChange={(event) => set({ title: event.target.value })}
          autoFocus={card.title.startsWith("New ")}
        />
      </Field>

      <Field label="Description">
        <textarea
          className="input input--area"
          value={card.description}
          maxLength={20_000}
          rows={3}
          onChange={(event) => set({ description: event.target.value })}
        />
      </Field>

      <Field label="Type">
        <select
          className="input"
          value={card.type}
          onChange={(event) => set({ type: event.target.value as NodeKind })}
        >
          {CARD_KINDS.map(({ kind, label, hint }) => (
            <option key={kind} value={kind}>
              {label}: {hint}
            </option>
          ))}
        </select>
      </Field>

      {card.type === "artifact" && (
        <DeliverSection deliverTo={card.deliverTo} onChange={(deliverTo) => set({ deliverTo })} />
      )}

      {!isNote && (
        <>
          <StatusSection card={card} onChange={onChange} />

          <Section title="Who owns what">
            <ListEditor
              label="Agent owns"
              items={card.proposal.agentOwns}
              placeholder="e.g. Write the draft from the research"
              onChange={(agentOwns) => onChange((c) => ({ ...c, proposal: { ...c.proposal, agentOwns } }))}
            />
            <ListEditor
              label="You own"
              items={card.proposal.youOwn}
              placeholder="e.g. Set tone, length and audience"
              onChange={(youOwn) => onChange((c) => ({ ...c, proposal: { ...c.proposal, youOwn } }))}
            />
          </Section>

          <SetupEditor tasks={card.setup} onChange={(setup) => onChange((c) => ({ ...c, setup }))} />
        </>
      )}

      {runsAsStep(card.type) && (
        <RunSection key={card.id} run={card.run} onChange={(run) => onChange((c) => ({ ...c, run }))} />
      )}

      <div className="details__footer">
        <button type="button" className="btn btn--danger" onClick={onDelete}>
          Delete card
        </button>
      </div>
    </aside>
  );
}

function StatusSection({ card, onChange }: Pick<CardDetailsProps, "card" | "onChange">) {
  const approved = card.readiness !== "proposed";
  return (
    <Section title="Status">
      <div className="status-row">
        <span className={`pill pill--${card.readiness}`}>{READINESS_LABEL[card.readiness]}</span>
        {approved ? (
          <button
            type="button"
            className="btn"
            onClick={() => onChange((c) => ({ ...c, readiness: "proposed" }))}
          >
            Move back to proposed
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onChange((c) => ({ ...c, readiness: "not_configured" }))}
          >
            Approve
          </button>
        )}
      </div>
      <p className="hint">
        {approved
          ? "Configured turns on by itself when every setup check is ticked, and off again if one is unticked."
          : "Proposed means drafted but not yet approved. Approving it lets the setup checklist decide when it is configured."}
      </p>
    </Section>
  );
}

// ----------------------------------------------------------- delivery

/**
 * Where an artifact card's output is delivered. The list comes from the
 * connected Hermes (local file is always offered); the conductor, not the
 * canvas, performs the send. Picking nothing keeps the output in the run only.
 */
function DeliverSection({ deliverTo, onChange }: { deliverTo: string; onChange: (deliverTo: string) => void }) {
  const [targets, setTargets] = useState<DeliveryTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchDeliveryTargets()
      .then((list) => live && setTargets(list))
      .catch(() => live && setError("Could not load delivery targets from Hermes."));
    return () => {
      live = false;
    };
  }, []);
  const offered = targets ?? [];
  const staleSelection = deliverTo !== "" && !offered.some((target) => target.id === deliverTo);
  return (
    <Section title="Deliver this output">
      <p className="hint">
        Where this result is sent once a run reaches this card. The connected Hermes sends it; the canvas never does.
      </p>
      <Field label="Send to">
        <select className="input" value={deliverTo} onChange={(event) => onChange(event.target.value)} aria-label="Delivery target">
          <option value="">Don't deliver</option>
          {offered.map((target) => (
            <option key={target.id} value={target.id}>
              {target.label}
            </option>
          ))}
          {staleSelection && <option value={deliverTo}>{deliverTo} (not offered now)</option>}
        </select>
      </Field>
      {error && <p className="field-error">{error}</p>}
      {targets && offered.length <= 1 && (
        <p className="hint">Only a local file is available until a Hermes with messaging targets is connected.</p>
      )}
    </Section>
  );
}

// --------------------------------------------------------- run settings

/**
 * Who would do this step if a run is requested. Names only: nothing here
 * runs, and a Hermes-side conductor checks the names against its own list.
 * Each field keeps a local draft and is written to the card only when valid,
 * so a half-typed name never blocks saving.
 */
function RunSection({ run, onChange }: { run: RunSettings; onChange: (run: RunSettings) => void }) {
  const [executor, setExecutor] = useState(run.executor);
  const [skills, setSkills] = useState(run.skills.join("\n"));
  const [minutes, setMinutes] = useState(String(run.maxRuntimeMinutes));

  const executorOk = executor.trim() === "" || EXECUTOR_PATTERN.test(executor.trim());
  const skillLines = skills.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const skillsOk = skillLines.length <= MAX_SKILLS && skillLines.every(isSkillName);
  const minutesValue = Number(minutes);
  const minutesOk = Number.isInteger(minutesValue) && minutesValue >= 1 && minutesValue <= MAX_RUNTIME_MINUTES;

  return (
    <Section title="If this runs">
      <p className="hint">Names only. Nothing runs from the canvas; a run request is checked before anything is handed to Hermes.</p>
      <Field label="Done by (Hermes profile)">
        <input
          className={`input${executorOk ? "" : " input--bad"}`}
          value={executor}
          maxLength={64}
          placeholder="e.g. writer"
          aria-invalid={!executorOk}
          spellCheck={false}
          onChange={(event) => {
            setExecutor(event.target.value);
            const next = event.target.value.trim();
            if ((next === "" || EXECUTOR_PATTERN.test(next)) && next !== run.executor) onChange({ ...run, executor: next });
          }}
        />
        {!executorOk && <p className="field-error">Lowercase letters, digits, - and _ only. Not saved until fixed.</p>}
      </Field>
      <Field label="Skills to load (one per line)">
        <textarea
          className={`input input--area${skillsOk ? "" : " input--bad"}`}
          value={skills}
          rows={2}
          placeholder="e.g. research/daily-digest"
          aria-invalid={!skillsOk}
          spellCheck={false}
          onChange={(event) => {
            setSkills(event.target.value);
            const lines = event.target.value.split("\n").map((line) => line.trim()).filter((line) => line !== "");
            if (lines.length <= MAX_SKILLS && lines.every(isSkillName) && lines.join("\n") !== run.skills.join("\n")) {
              onChange({ ...run, skills: lines });
            }
          }}
        />
        {!skillsOk && <p className="field-error">Skill names use lowercase letters, digits, . - _ and / for a category. Not saved until fixed.</p>}
      </Field>
      <Field label="Time limit per attempt (minutes)">
        <input
          className={`input input--short${minutesOk ? "" : " input--bad"}`}
          type="number"
          min={1}
          max={MAX_RUNTIME_MINUTES}
          value={minutes}
          aria-invalid={!minutesOk}
          onChange={(event) => {
            setMinutes(event.target.value);
            const value = Number(event.target.value);
            if (Number.isInteger(value) && value >= 1 && value <= MAX_RUNTIME_MINUTES && value !== run.maxRuntimeMinutes) {
              onChange({ ...run, maxRuntimeMinutes: value });
            }
          }}
        />
        {!minutesOk && <p className="field-error">A whole number from 1 to {MAX_RUNTIME_MINUTES}. Not saved until fixed.</p>}
      </Field>
    </Section>
  );
}

// ---------------------------------------------------------- owner lists

function ListEditor({
  label,
  items,
  placeholder,
  onChange,
}: {
  label: string;
  items: string[];
  placeholder: string;
  onChange: (items: string[]) => void;
}) {
  return (
    <div className="list-editor">
      <div className="list-editor__label">{label}</div>
      {items.map((item, index) => (
        <div className="row" key={index}>
          <input
            className="input"
            value={item}
            maxLength={2_000}
            placeholder={placeholder}
            aria-label={`${label} ${index + 1}`}
            onChange={(event) => onChange(items.map((old, i) => (i === index ? event.target.value : old)))}
          />
          <RemoveButton label={`Remove ${label.toLowerCase()} line ${index + 1}`} onClick={() => onChange(items.filter((_, i) => i !== index))} />
        </div>
      ))}
      <button type="button" className="btn btn--add" onClick={() => onChange([...items, ""])}>
        + Add line
      </button>
    </div>
  );
}

// ------------------------------------------------------- setup checklist

function SetupEditor({ tasks, onChange }: { tasks: SetupTask[]; onChange: (tasks: SetupTask[]) => void }) {
  const done = tasks.filter((task) => task.done).length;
  const update = (id: string, patch: Partial<SetupTask>) =>
    onChange(tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)));

  return (
    <Section title={`Setup checklist${tasks.length > 0 ? ` (${done}/${tasks.length})` : ""}`}>
      {tasks.length === 0 && <p className="hint">Checks this step must pass before it can hand off.</p>}
      {tasks.map((task, index) => (
        <SetupTaskRow
          key={task.id}
          task={task}
          index={index}
          onChange={(patch) => update(task.id, patch)}
          onRemove={() => onChange(tasks.filter((other) => other.id !== task.id))}
        />
      ))}
      <button
        type="button"
        className="btn btn--add"
        onClick={() => onChange([...tasks, { id: makeId("check"), text: "", detail: "", link: "", done: false }])}
      >
        + Add check
      </button>
    </Section>
  );
}

function SetupTaskRow({
  task,
  index,
  onChange,
  onRemove,
}: {
  task: SetupTask;
  index: number;
  onChange: (patch: Partial<SetupTask>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(task.detail !== "" || task.link !== "");
  return (
    <div className={`check${task.done ? " check--done" : ""}`}>
      <div className="row">
        <input
          type="checkbox"
          className="check__box"
          checked={task.done}
          aria-label={`Check ${index + 1} done`}
          onChange={(event) => onChange({ done: event.target.checked })}
        />
        <input
          className="input"
          value={task.text}
          maxLength={2_000}
          placeholder="e.g. Pick the review model"
          aria-label={`Check ${index + 1}`}
          onChange={(event) => onChange({ text: event.target.value })}
        />
        <button
          type="button"
          className="icon-btn"
          aria-expanded={open}
          aria-label={open ? "Hide note and link" : "Add a note or link"}
          title={open ? "Hide note and link" : "Add a note or link"}
          onClick={() => setOpen(!open)}
        >
          {open ? "−" : "…"}
        </button>
        <RemoveButton label={`Remove check ${index + 1}`} onClick={onRemove} />
      </div>
      {open && (
        <div className="check__more">
          <textarea
            className="input input--area"
            value={task.detail}
            maxLength={2_000}
            rows={2}
            placeholder="Why it matters (optional)"
            aria-label={`Check ${index + 1} note`}
            onChange={(event) => onChange({ detail: event.target.value })}
          />
          <LinkField value={task.link} index={index} onCommit={(link) => onChange({ link })} />
        </div>
      )}
    </div>
  );
}

/**
 * A link is only written to the card once it is empty or a valid http(s)
 * address, so a half-typed URL never reaches the server and blocks saving.
 */
function LinkField({ value, index, onCommit }: { value: string; index: number; onCommit: (link: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const trimmed = draft.trim();
  const valid = isSafeLink(trimmed);

  return (
    <div className="link-field">
      <div className="row">
        <input
          className={`input${valid ? "" : " input--bad"}`}
          value={draft}
          maxLength={2_000}
          placeholder="https://… (optional)"
          aria-label={`Check ${index + 1} link`}
          aria-invalid={!valid}
          onChange={(event) => {
            setDraft(event.target.value);
            const next = event.target.value.trim();
            if (isSafeLink(next) && next !== value) onCommit(next);
          }}
        />
        {value !== "" && valid && trimmed === value && (
          <a className="link-field__open" href={value} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        )}
      </div>
      {!valid && <p className="field-error">Links must start with http:// or https://. Not saved until fixed.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- arrow

type EdgeDetailsProps = {
  edge: WorkflowEdge;
  sourceTitle: string;
  targetTitle: string;
  onChange: (edge: WorkflowEdge) => void;
  onDelete: () => void;
  onClose: () => void;
};

export function EdgeDetails({ edge, sourceTitle, targetTitle, onChange, onDelete, onClose }: EdgeDetailsProps) {
  const [label, setLabel] = useState(edge.label);
  useEffect(() => setLabel(edge.label), [edge.id, edge.label]);
  const needsLabel = edge.type === "conditional" && label.trim() === "";

  return (
    <aside className="details" aria-label="Arrow details">
      <PanelHeader title="Arrow" onClose={onClose} />
      <p className="details__route">
        <strong>{sourceTitle || "Untitled step"}</strong> → <strong>{targetTitle || "Untitled step"}</strong>
      </p>
      {edge.inferred && <InferredNotice what="arrow" onConfirm={() => onChange({ ...edge, inferred: false })} />}

      <div className="field">
        <span className="field__label">Kind</span>
        <div className="kind-options" role="radiogroup" aria-label="Arrow kind">
          {EDGE_KINDS.map(({ kind, hint }) => (
            <label key={kind} className={`kind-option kind-option--${kind}${edge.type === kind ? " kind-option--on" : ""}`}>
              <input
                type="radio"
                name="edge-kind"
                value={kind}
                checked={edge.type === kind}
                onChange={() =>
                  onChange({
                    ...edge,
                    type: kind,
                    // A conditional arrow must say when it is taken.
                    label: kind === "conditional" && edge.label.trim() === "" ? "when…" : edge.label,
                  })
                }
              />
              <span className="kind-option__name">{EDGE_LABEL[kind]}</span>
              <span className="kind-option__hint">{hint}</span>
            </label>
          ))}
        </div>
      </div>

      <Field label={edge.type === "conditional" ? "Condition (required)" : "Label (optional)"}>
        <input
          className={`input${needsLabel ? " input--bad" : ""}`}
          value={label}
          maxLength={500}
          placeholder={edge.type === "conditional" ? "e.g. approved" : "e.g. notes"}
          onChange={(event) => {
            setLabel(event.target.value);
            // Never store an empty condition; keep the last good one until fixed.
            if (!(edge.type === "conditional" && event.target.value.trim() === "")) {
              onChange({ ...edge, label: event.target.value });
            }
          }}
        />
        {needsLabel && <p className="field-error">A conditional arrow needs a condition. Not saved until filled in.</p>}
      </Field>

      <div className="details__footer">
        <button type="button" className="btn btn--danger" onClick={onDelete}>
          Delete arrow
        </button>
      </div>
    </aside>
  );
}

// -------------------------------------------------------------- pieces

/** Inferred means an agent or importer drew this, not a person. Confirming is a human step. */
function InferredNotice({ what, onConfirm }: { what: "card" | "arrow"; onConfirm: () => void }) {
  return (
    <div className="inferred-notice" role="note">
      <p>
        <strong>Inferred.</strong> This {what} was drawn from a source by an agent, not by you. Check it against the
        source, then confirm. A run will not use it until you do.
      </p>
      <button type="button" className="btn btn--primary" onClick={onConfirm}>
        Confirm this {what}
      </button>
    </div>
  );
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="details__head">
      <h2>{title}</h2>
      <button type="button" className="icon-btn" aria-label="Close details" title="Close" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="details__section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="icon-btn icon-btn--remove" aria-label={label} title="Remove" onClick={onClick}>
      ×
    </button>
  );
}
