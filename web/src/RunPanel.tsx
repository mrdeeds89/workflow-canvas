import { useCallback, useEffect, useState } from "react";
import { preflight, type PlannedStage } from "../../src/graph/preflight.ts";
import type { RunView } from "../../src/graph/run-types.ts";
import type { WorkflowDefinition } from "../../src/graph/types.ts";
import { ApiError, cancelRun, fetchRuns, requestRun, type RunsListing } from "./api.ts";

/**
 * "What would run": the run rules applied to the canvas as it is now.
 *
 * Nothing on this panel starts work. "Request run" records a request for the
 * saved revision; no conductor reads it yet, and it expires on its own.
 * Every value renders as React text.
 */

type Props = {
  workflowId: string;
  definition: WorkflowDefinition;
  /** Save pending edits; resolves to the stored revision, or null if saving failed. */
  settle: () => Promise<number | null>;
  onSelectCard: (id: string) => void;
  onClose: () => void;
};

const STATUS: Record<RunView["status"], string> = {
  requested: "Requested, waiting for a conductor",
  expired: "Expired, never picked up",
  cancelled: "Cancelled",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function RunPanel({ workflowId, definition, settle, onSelectCard, onClose }: Props) {
  const plan = preflight(definition, null);
  const titleOf = (id: string) => {
    const title = definition.nodes.find((card) => card.id === id)?.title.trim() ?? "";
    return title === "" ? "Untitled card" : title;
  };
  const [listing, setListing] = useState<RunsListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<string[]>([]);

  const reload = useCallback(async () => {
    try {
      setListing(await fetchRuns(workflowId));
    } catch (failure) {
      setError(`Could not load run requests: ${messageOf(failure)}`);
    }
  }, [workflowId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const open = listing?.runs.find((run) => run.status === "requested") ?? null;

  const onRequest = async () => {
    setBusy(true);
    setError(null);
    setServerIssues([]);
    try {
      const revision = await settle();
      if (revision === null) {
        setError("Your latest edits are not saved yet, so nothing was requested.");
        return;
      }
      await requestRun(workflowId, revision);
      await reload();
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "preflight_failed") {
        setServerIssues(failure.issues.map((item) => item.message));
      }
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const onCancel = async (runId: string) => {
    setBusy(true);
    setError(null);
    try {
      await cancelRun(workflowId, runId);
      await reload();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="harness runplan" aria-label="What would run">
      <div className="brief__head">
        <h2>What would run</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="harness__muted">
        Hermes would do the work, card by card. No conductor is connected yet, so a request is only recorded. It expires
        after {Math.round((listing?.requestTtlMs ?? 900_000) / 60_000)} minutes and nothing runs on any harness.
      </p>

      <div className="harness__body">
        <div>
          {plan.issues.length > 0 ? (
            <>
              <p className="harness__result harness__result--warn">
                Can't run yet: {plan.issues.length} {plan.issues.length === 1 ? "thing" : "things"} to fix
              </p>
              <ul className="runplan__issues" aria-label="Things to fix before a run">
                {plan.issues.map((item, index) => (
                  <li key={`${item.code}-${item.cardId ?? item.edgeId ?? ""}-${index}`}>
                    {item.cardId ? (
                      <button type="button" className="runplan__link" onClick={() => onSelectCard(item.cardId!)}>
                        {item.message}
                      </button>
                    ) : (
                      item.message
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="harness__result harness__result--ok">Ready to request: every step passes the run checks</p>
          )}
          {plan.notices.length > 0 && (
            <ul className="runplan__notices">
              {plan.notices.map((notice) => (
                <li key={notice}>{notice}</li>
              ))}
            </ul>
          )}
          <div className="harness__actions runplan__actions">
            <button type="button" disabled={busy || !plan.ok || open !== null} onClick={() => void onRequest()}>
              Request run
            </button>
            {open && <span className="harness__muted">A request is already open.</span>}
          </div>
          {error && (
            <p className="harness__error" role="alert">
              {error}
            </p>
          )}
          {serverIssues.length > 0 && (
            <ul className="runplan__issues">
              {serverIssues.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <Stages stages={plan.stages} titleOf={titleOf} />
          <RunList runs={listing?.runs ?? []} busy={busy} onCancel={(id) => void onCancel(id)} />
        </div>
      </div>
    </section>
  );
}

function Stages({ stages, titleOf }: { stages: PlannedStage[]; titleOf: (id: string) => string }) {
  if (stages.length === 0) return <p className="harness__muted">No steps to show yet.</p>;
  return (
    <ol className="runplan__stages" aria-label="Stages">
      {stages.map((stage) => (
        <li key={stage.index} className="runplan__stage">
          <div className="runplan__stage-head">
            Stage {stage.index + 1}
            {stage.afterApprovals.length > 0 && <> · after you approve {stage.afterApprovals.map(titleOf).join(", ")}</>}
            {stage.afterDecisions.length > 0 && <> · after {stage.afterDecisions.map(titleOf).join(", ")} picks a branch</>}
          </div>
          <ul>
            {stage.steps.map((step) => (
              <li key={step.cardId} className={`runplan__step runplan__step--${step.role}`}>
                <span className="runplan__step-title">{titleOf(step.cardId)}</span>
                {step.role === "approval" ? (
                  <span className="harness__muted"> · waits for you</span>
                ) : (
                  <span className="harness__muted">
                    {" "}
                    · {step.executor === "" ? "no profile" : step.executor}
                    {step.skills.length > 0 && <> · {step.skills.join(", ")}</>} · up to {step.maxRuntimeMinutes} min
                  </span>
                )}
                {step.branches.length > 0 && (
                  <span className="harness__muted">
                    {" "}
                    · only if{" "}
                    {step.branches
                      .map((item) => `${titleOf(item.decisionCardId)} picks ${item.branches.map((value) => `"${value}"`).join(" or ")}`)
                      .join(" and ")}
                  </span>
                )}
                {step.decides.length > 0 && (
                  <span className="harness__muted"> · picks one of: {step.decides.map((value) => `"${value}"`).join(", ")}</span>
                )}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function RunList({ runs, busy, onCancel }: { runs: RunView[]; busy: boolean; onCancel: (id: string) => void }) {
  if (runs.length === 0) return <p className="harness__muted">No run requests yet.</p>;
  return (
    <table className="harness__runs" aria-label="Run requests">
      <thead>
        <tr>
          <th scope="col">Status</th>
          <th scope="col">Revision</th>
          <th scope="col">Requested</th>
          <th scope="col">Steps</th>
          <th scope="col" />
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td>{STATUS[run.status]}</td>
            <td>{run.revision}</td>
            <td>{new Date(run.requestedAt).toLocaleString()}</td>
            <td>{run.stepCount}</td>
            <td>
              {run.status === "requested" && (
                <button type="button" disabled={busy} onClick={() => onCancel(run.id)}>
                  Cancel
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
