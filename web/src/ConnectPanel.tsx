import { useCallback, useEffect, useState } from "react";
import { disconnect, fetchConnection, startPairing, type ConnectionView } from "./api.ts";

/**
 * Connect a Hermes to this Canvas. Canvas never runs anything; a connected
 * Hermes does the work and delivers results, and Canvas holds no key that can
 * start work. Connecting shows a one-time pairing code to type into the
 * installer on the Hermes machine.
 */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function ConnectPanel({ onClose }: { onClose: () => void }) {
  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setConnection(await fetchConnection());
    } catch (failure) {
      setError(`Could not read the connection: ${messageOf(failure)}`);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onPair = async () => {
    setBusy(true);
    setError(null);
    try {
      setCode(await startPairing());
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnect();
      setCode(null);
      await reload();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const minutesLeft = code ? Math.max(1, Math.round((code.expiresAt - Date.now()) / 60_000)) : 0;

  return (
    <section className="harness" aria-label="Connect Hermes">
      <div className="brief__head">
        <h2>Connect Hermes</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="harness__muted">
        Workflow Canvas never runs anything. A Hermes you connect does the work and delivers results. Canvas holds no key
        that can start work.
      </p>

      <div className="harness__body">
        <div>
          <p className={`harness__result ${connection?.connected ? "harness__result--ok" : "harness__result--warn"}`}>
            {connection?.connected ? "A Hermes is connected." : "No Hermes connected yet."}
          </p>

          {!connection?.connected && (
            <div className="connect__pair">
              <button type="button" disabled={busy} onClick={() => void onPair()}>
                Show a pairing code
              </button>
              {code && (
                <div className="connect__code" role="group" aria-label="Pairing code">
                  <p>On the Hermes machine, run the installer and give it this one-time code:</p>
                  <code className="connect__code-value">{code.code}</code>
                  <p className="harness__muted">Valid for about {minutesLeft} minutes, and only once.</p>
                </div>
              )}
            </div>
          )}

          {connection?.connected && (
            <div className="connect__actions">
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void onDisconnect()}>
                Disconnect this Hermes
              </button>
              <p className="harness__muted">Disconnecting revokes the conductor's token. Runs already recorded are kept.</p>
            </div>
          )}

          {error && (
            <p className="harness__error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div>
          <h3>Where results can go</h3>
          <ul className="connect__targets" aria-label="Delivery targets">
            {(connection?.targets ?? []).map((target) => (
              <li key={target.id}>
                {target.label}
                {target.kind === "local-file" && <span className="harness__muted"> · built in</span>}
              </li>
            ))}
          </ul>
          {connection && connection.targets.length <= 1 && (
            <p className="harness__muted">Messaging targets (Telegram, and so on) appear here after the connected Hermes reports them.</p>
          )}
        </div>
      </div>
    </section>
  );
}
