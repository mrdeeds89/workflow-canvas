import { useCallback, useEffect, useState } from "react";
import { preflight, type PlannedStage } from "../../src/graph/preflight.ts";
import type { RunDetail, RunStepOutcome, RunView } from "../../src/graph/run-types.ts";
import type { WorkflowDefinition } from "../../src/graph/types.ts";
import { ApiError, approveRun, cancelRun, fetchRun, fetchRuns, requestRun, type RunsListing } from "./api.ts";

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
  claimed: "Claimed by the conductor",
  running: "Running",
  "waiting-approval": "Waiting for approval",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
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

  const onApprove = async (runId: string, cardId: string, decision: "approved" | "rejected") => {
    setBusy(true);
    setError(null);
    try {
      await approveRun(workflowId, runId, cardId, decision);
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
          <RunList
            runs={listing?.runs ?? []}
            workflowId={workflowId}
            busy={busy}
            titleOf={titleOf}
            onCancel={(id) => void onCancel(id)}
            onApprove={(runId, cardId, decision) => void onApprove(runId, cardId, decision)}
          />
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

const TERMINAL = new Set<RunView["status"]>(["completed", "failed", "stopped", "cancelled", "expired"]);

type RunListProps = {
  runs: RunView[];
  workflowId: string;
  busy: boolean;
  titleOf: (id: string) => string;
  onCancel: (id: string) => void;
  onApprove: (runId: string, cardId: string, decision: "approved" | "rejected") => void;
};

function RunList({ runs, workflowId, busy, titleOf, onCancel, onApprove }: RunListProps) {
  const [open, setOpen] = useState<string | null>(null);
  if (runs.length === 0) return <p className="harness__muted">No run requests yet.</p>;
  return (
    <ul className="runplan__runs" aria-label="Runs">
      {runs.map((run) => {
        const active = !TERMINAL.has(run.status);
        const expanded = open === run.id;
        return (
          <li key={run.id} className="runplan__run">
            <div className="runplan__run-head">
              <button
                type="button"
                className="runplan__run-toggle"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : run.id)}
              >
                {expanded ? "▾" : "▸"} <span className={`runbadge runbadge--${run.status}`}>{STATUS[run.status]}</span>
                <span className="harness__muted"> · rev {run.revision} · {run.stepCount} steps</span>
              </button>
              {active && (
                <button type="button" disabled={busy} onClick={() => onCancel(run.id)}>
                  {run.status === "requested" ? "Cancel" : "Stop"}
                </button>
              )}
            </div>
            {expanded && (
              <RunDetailView
                workflowId={workflowId}
                runId={run.id}
                titleOf={titleOf}
                busy={busy}
                canApprove={active}
                onApprove={onApprove}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

const OUTCOME_LABEL: Record<RunStepOutcome["status"], string> = {
  created: "created",
  running: "running",
  completed: "done",
  failed: "failed",
  blocked: "blocked",
  "timed-out": "timed out",
  "gave-up": "gave up",
};

/** One run's reported detail: per-card outcomes, approvals, and deliveries. */
function RunDetailView({
  workflowId,
  runId,
  titleOf,
  busy,
  canApprove,
  onApprove,
}: {
  workflowId: string;
  runId: string;
  titleOf: (id: string) => string;
  busy: boolean;
  canApprove: boolean;
  onApprove: (runId: string, cardId: string, decision: "approved" | "rejected") => void;
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchRun(workflowId, runId)
      .then((value) => live && setDetail(value))
      .catch((failure) => live && setError(messageOf(failure)));
    return () => {
      live = false;
    };
  }, [workflowId, runId, busy]);

  if (error) return <p className="harness__error">{error}</p>;
  if (!detail) return <p className="harness__muted">Loading run…</p>;

  const outcomeOf = new Map((detail.outcomes?.steps ?? []).map((step) => [step.cardId, step]));
  const decisionOf = new Map(detail.approvals.map((approval) => [approval.cardId, approval.decision]));
  const approvalCards = detail.plan.stages.flatMap((stage) => stage.steps).filter((step) => step.role === "approval");
  const deliveries = detail.outcomes?.deliveries ?? [];

  return (
    <div className="runplan__detail">
      <div className="runplan__detail-cards">
        {detail.plan.stages.flatMap((stage) => stage.steps).map((step) => {
          const outcome = outcomeOf.get(step.cardId);
          return (
            <div key={step.cardId} className="runplan__detail-card">
              <span className="runplan__step-title">{titleOf(step.cardId)}</span>
              {step.role === "approval" ? (
                <span className="harness__muted"> · approval</span>
              ) : outcome ? (
                <span className={`runbadge runbadge--${outcome.status}`}>
                  {OUTCOME_LABEL[outcome.status]}
                  {outcome.branch ? ` · branch "${outcome.branch}"` : ""} · reported by Kanban
                </span>
              ) : (
                <span className="harness__muted"> · not created yet</span>
              )}
            </div>
          );
        })}
      </div>

      {approvalCards.length > 0 && (
        <div className="runplan__approvals">
          <h4>Approvals</h4>
          {approvalCards.map((step) => {
            const decision = decisionOf.get(step.cardId);
            return (
              <div key={step.cardId} className="runplan__approval">
                <span className="runplan__step-title">{titleOf(step.cardId)}</span>
                {decision ? (
                  <span className={`runbadge runbadge--${decision === "approved" ? "completed" : "failed"}`}>{decision}</span>
                ) : canApprove ? (
                  <span className="runplan__approval-actions">
                    <button type="button" disabled={busy} onClick={() => onApprove(runId, step.cardId, "approved")}>
                      Approve
                    </button>
                    <button type="button" disabled={busy} onClick={() => onApprove(runId, step.cardId, "rejected")}>
                      Reject
                    </button>
                  </span>
                ) : (
                  <span className="harness__muted">not decided</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {deliveries.length > 0 && (
        <div className="runplan__deliveries">
          <h4>Deliveries</h4>
          {deliveries.map((delivery) => (
            <div key={delivery.cardId} className="runplan__delivery">
              <span className="runplan__step-title">{titleOf(delivery.cardId)}</span>
              <span className={`runbadge runbadge--${delivery.status === "sent" ? "completed" : delivery.status === "failed" ? "failed" : "created"}`}>
                {delivery.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
