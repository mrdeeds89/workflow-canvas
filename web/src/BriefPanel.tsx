import { BRIEF_HEADINGS, MAX_BRIEF_LENGTH } from "../../src/graph/types.ts";

const PLACEHOLDER = BRIEF_HEADINGS.join("\n\n");

type BriefPanelProps = {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
};

/** One plain-text box. Headings are a suggestion, not separate fields. */
export function BriefPanel({ value, onChange, onClose }: BriefPanelProps) {
  return (
    <section className="brief" aria-label="Workflow brief">
      <div className="brief__head">
        <h2>Workflow brief</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="brief__hint">
        Plain text for people and future agents. Suggested headings: {BRIEF_HEADINGS.join(", ")}. Stored
        as written. Nothing here runs.
      </p>
      <textarea
        className="brief__input"
        aria-label="Workflow brief text"
        placeholder={PLACEHOLDER}
        value={value}
        maxLength={MAX_BRIEF_LENGTH}
        spellCheck
        onChange={(event) => onChange(event.target.value)}
      />
    </section>
  );
}
