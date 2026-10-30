import { useCallback, useEffect, useRef, useState } from "react";
import { describeEvidence, JOB_ID_PATTERN, lookup, type Evidence, type ExecutionRecord } from "../../src/harness/observation.ts";
import {
  ApiError,
  fetchHarnesses,
  fetchJobEvidence,
  linkJob,
  refreshJob,
  unlinkJob,
  type HarnessSummary,
  type JobEvidenceView,
} from "./api.ts";

/**
 * Read-only evidence from a linked Hermes job.
 *
 * Every value here came from another system. It is rendered as text, never
 * as markup, and nothing on this panel can run, pause, resume, or edit the job.
 * The result is the whole job's; it never colours a card on the canvas.
 */

type Props = { workflowId: string; onClose: () => void };

const TICK_MS = 15_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function formatAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

function when(value: string | null): string {
  if (value === null) return "—";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

const ATTEMPT: Record<string, string> = {
  completed: "Completed",
  failed: "Failed",
  running: "Running",
  claimed: "Starting",
  unknown: "Unknown (owner lost)",
};

const DELIVERY: Record<string, string> = {
  delivered: "Delivered",
  suppressed: "Suppressed (silent)",
  queued: "Queued",
  failed: "Failed",
};

function Attempts({ runs }: { runs: ExecutionRecord[] }) {
  if (runs.length === 0) return <p className="harness__muted">No attempts recorded.</p>;
  return (
    <table className="harness__runs" aria-label="Recent attempts">
      <thead>
        <tr>
          <th scope="col">Status</th>
          <th scope="col">Scheduled for</th>
          <th scope="col">Started</th>
          <th scope="col">Finished</th>
          <th scope="col">Delivery</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td className={run.status === "failed" || run.status === "unknown" ? "harness__bad" : undefined}>
              {run.status === null ? "—" : (lookup(ATTEMPT, run.status) ?? `Unrecognized: ${run.status}`)}
            </td>
            <td>{run.scheduledInstant ? when(run.scheduledInstant) : "Off schedule"}</td>
            <td>{when(run.startedAt)}</td>
            <td>{when(run.finishedAt)}</td>
            <td className={run.deliveryOutcome === "failed" ? "harness__bad" : undefined}>
              {run.deliveryOutcome === null ? "—" : (lookup(DELIVERY, run.deliveryOutcome) ?? `Unrecognized: ${run.deliveryOutcome}`)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LinkForm({
  harnesses,
  busy,
  onLink,
}: {
  harnesses: HarnessSummary[];
  busy: boolean;
  onLink: (harness: string, profile: string, jobId: string) => void;
}) {
  const [harness, setHarness] = useState(harnesses[0]?.label ?? "");
  const chosen = harnesses.find((item) => item.label === harness);
  const [profile, setProfile] = useState(chosen?.profiles[0] ?? "");
  const [jobId, setJobId] = useState("");
  const validId = JOB_ID_PATTERN.test(jobId);

  if (harnesses.length === 0) {
    return (
      <p className="harness__muted">
        No Hermes harness is configured on this server, so there is nothing to link. See docs/HERMES-INTEGRATION.md.
      </p>
    );
  }
  return (
    <form
      className="harness__form"
      aria-label="Link a Hermes job"
      onSubmit={(event) => {
        event.preventDefault();
        if (validId && chosen && chosen.profiles.includes(profile)) onLink(harness, profile, jobId);
      }}
    >
      <label>
        Harness
        <select
          value={harness}
          onChange={(event) => {
            setHarness(event.target.value);
            setProfile(harnesses.find((item) => item.label === event.target.value)?.profiles[0] ?? "");
          }}
        >
          {harnesses.map((item) => (
            <option key={item.label} value={item.label}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Profile
        <select value={profile} onChange={(event) => setProfile(event.target.value)}>
          {(chosen?.profiles ?? []).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Job ID
        <input
          value={jobId}
          list={chosen && chosen.exampleJobs.length > 0 ? "harness-example-jobs" : undefined}
          placeholder="from hermes cron list"
          spellCheck={false}
          autoComplete="off"
          maxLength={32}
          onChange={(event) => setJobId(event.target.value.trim().toLowerCase())}
        />
      </label>
      {chosen && chosen.exampleJobs.length > 0 && (
        <datalist id="harness-example-jobs">
          {chosen.exampleJobs.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
      )}
      <button type="submit" disabled={busy || !validId}>
        Link job
      </button>
      {jobId !== "" && !validId && <span className="harness__muted">A job ID is 6 to 32 hexadecimal characters.</span>}
    </form>
  );
}

function Linked({
  view,
  evidence,
  busy,
  onRefresh,
  onUnlink,
}: {
  view: JobEvidenceView & { link: NonNullable<JobEvidenceView["link"]> };
  evidence: Evidence;
  busy: boolean;
  onRefresh: () => void;
  onUnlink: () => void;
}) {
  const { link } = view;
  const job = evidence.job?.job ?? null;
  // Provenance describes the job data on screen; a newer refusal is reported beside it.
  const shown = job ? view.latestJob : (view.latestAny ?? view.latestJob);
  const shownAge = job ? evidence.jobAgeMs : evidence.ageMs;
  const provenance = shown?.observation.harness;
  const newerCheck =
    job && view.latestAny && view.latestJob && view.latestAny.observation.kind === "refused" && view.latestAny.receivedAt > view.latestJob.receivedAt
      ? view.latestAny
      : null;
  return (
    <>
      <div className="harness__identity">
        <div>
          <strong className="harness__name">{job?.name || `Job ${link.jobId}`}</strong>
          <span className="harness__muted">
            {" "}
            {link.harness} / {link.profile} · job {link.jobId}
          </span>
        </div>
        <div className="harness__actions">
          <button type="button" onClick={onRefresh} disabled={busy}>
            {busy ? "Checking…" : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Unlink this Hermes job? The job itself is not changed.")) onUnlink();
            }}
            disabled={busy}
          >
            Unlink
          </button>
        </div>
      </div>

      {evidence.flags.length > 0 && (
        <ul className="harness__flags" aria-label="Job evidence warnings">
          {evidence.flags.map((flag) => (
            <li key={flag.code} className={`harness__flag harness__flag--${flag.tone}`} data-flag={flag.code}>
              {flag.text}
            </li>
          ))}
        </ul>
      )}

      {evidence.result && (
        <p className={`harness__result harness__result--${evidence.result.tone}`} data-result={evidence.result.code}>
          <span className="harness__label">Latest result (whole job):</span> {evidence.result.text}
          {job?.hasErrorDetail && evidence.result.tone !== "ok" ? ". Details are kept on the harness." : ""}
        </p>
      )}
      {job && (
        <p className="harness__muted harness__scope">
          Hermes reports one result for the whole run. It does not say which steps on this canvas ran.
        </p>
      )}

      <div className="harness__body">
      {job && (
        <dl className="harness__facts">
          <dt>Schedule</dt>
          <dd>
            {job.schedule.display ?? "—"}
            {job.schedule.kind ? ` (${job.schedule.kind})` : ""}
            {job.timezone ? ` · ${job.timezone}` : ""}
          </dd>
          <dt>State</dt>
          <dd data-state={job.displayState ?? ""}>
            {job.displayState ?? "—"} · {job.enabled ? "enabled" : "disabled"}
          </dd>
          <dt>Next run</dt>
          <dd>{job.displayState === "paused" ? `${when(job.nextRunAt)} (paused)` : when(job.nextRunAt)}</dd>
          <dt>Last run</dt>
          <dd>{when(job.lastRunAt)}</dd>
          <dt>Delivers to</dt>
          <dd>{job.deliveryKinds.length > 0 ? job.deliveryKinds.join(", ") : "nowhere (local only)"}</dd>
          <dt>Runs</dt>
          <dd>
            {job.fingerprint.noAgent ? "script only, no agent" : "agent"}
            {job.fingerprint.scriptPresent && !job.fingerprint.noAgent ? " with a pre-run script" : ""}
            {job.fingerprint.skills.length > 0 ? ` · skills: ${job.fingerprint.skills.join(", ")}` : ""}
            {job.fingerprint.modelPinned ? " · own model" : ""}
          </dd>
        </dl>
      )}

      {evidence.job && (
        <details className="harness__history" open>
          <summary>Recent attempts</summary>
          <Attempts runs={evidence.job.executions} />
        </details>
      )}
      </div>

      <p className="harness__provenance" aria-label="Provenance">
        {shown && shownAge !== null ? (
          <>
            {job ? "Job details observed" : "Observed"} {formatAge(shownAge)} ago ({new Date(shown.receivedAt).toLocaleString()}) · source {shown.source}
            {provenance?.hermesVersion ? ` · Hermes ${provenance.hermesVersion}` : ""}
            {provenance?.exporterVersion ? ` · exporter ${provenance.exporterVersion}` : ""}
          </>
        ) : (
          "Not observed yet."
        )}
        {" · "}linked {new Date(link.linkedAt).toLocaleString()}
        {view.configured === false ? " · this harness is no longer configured on this server" : ""}
      </p>
      {newerCheck && evidence.ageMs !== null && newerCheck.observation.kind === "refused" && (
        <p className="harness__provenance" aria-label="Latest check">
          Latest check {formatAge(evidence.ageMs)} ago returned {newerCheck.observation.code}. The job details above are the last known.
        </p>
      )}
    </>
  );
}

export function HarnessPanel({ workflowId, onClose }: Props) {
  const [view, setView] = useState<JobEvidenceView | null>(null);
  const [harnesses, setHarnesses] = useState<HarnessSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  // Server clock minus this browser's clock, measured on each response.
  const offset = useRef(0);
  const opened = useRef(false);

  const accept = useCallback((next: JobEvidenceView) => {
    offset.current = next.serverNow - Date.now();
    setView(next);
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      accept(await refreshJob(workflowId));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 429) {
        setError(failure.message);
        const current = await fetchJobEvidence(workflowId).catch(() => null);
        if (current) accept(current);
      } else {
        setError(messageOf(failure));
      }
    } finally {
      setBusy(false);
    }
  }, [accept, workflowId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [loaded, list] = await Promise.all([fetchJobEvidence(workflowId), fetchHarnesses()]);
        if (cancelled) return;
        accept(loaded);
        setHarnesses(list);
        // Opening the panel counts as a page view: check once, within the server's rate limit.
        if (loaded.link && !opened.current) {
          opened.current = true;
          const last = loaded.link.lastAttemptAt;
          if (last === null || loaded.serverNow - last >= 60_000) void refresh();
        }
      } catch (failure) {
        if (!cancelled) setError(`Could not load job evidence: ${messageOf(failure)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId, accept, refresh]);

  useEffect(() => {
    const timer = setInterval(() => setTick((count) => count + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const doLink = async (harness: string, profile: string, jobId: string) => {
    setBusy(true);
    setError(null);
    try {
      accept(await linkJob(workflowId, harness, profile, jobId));
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
      return;
    }
    setBusy(false);
    await refresh();
  };

  const doUnlink = async () => {
    setBusy(true);
    setError(null);
    try {
      await unlinkJob(workflowId);
      accept(await fetchJobEvidence(workflowId));
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const link = view?.link ?? null;
  const evidence =
    view && link ? describeEvidence(link, view.latestJob, view.latestAny, Date.now() + offset.current, view.thresholds) : null;

  return (
    <section className="harness" aria-label="Job evidence">
      <div className="brief__head">
        <h2>Job evidence</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="brief__hint">
        Read-only view of a Hermes job. Linking does not change the job or this workflow, and nothing here runs,
        pauses, or resumes it.
      </p>
      {error && (
        <p className="harness__error" role="alert">
          {error}
        </p>
      )}
      {view === null || harnesses === null ? (
        error ? null : <p className="harness__muted">Loading…</p>
      ) : link && evidence ? (
        <Linked
          view={{ ...view, link }}
          evidence={evidence}
          busy={busy}
          onRefresh={() => void refresh()}
          onUnlink={() => void doUnlink()}
        />
      ) : (
        <LinkForm harnesses={harnesses} busy={busy} onLink={(h, p, j) => void doLink(h, p, j)} />
      )}
    </section>
  );
}
