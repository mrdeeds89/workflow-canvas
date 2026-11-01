import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { LOCAL_FILE_TARGET, type DeliveryTarget } from "./types.ts";

/**
 * Connecting a Hermes machine to Canvas.
 *
 * Canvas shows a one-time pairing code. The installer on the Hermes machine
 * trades it for a long conductor token. The token is the only credential a
 * conductor holds, and it can reach only the /api/conductor/* routes
 * (docs/R2-PLAN.md §3). Canvas keeps only hashes of the code and the token, so
 * a copy of the database cannot start work or impersonate a conductor.
 *
 * This module does not perform any run action. It issues and checks the
 * credential, and stores the delivery targets a connected Hermes reports.
 */

export const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_LABEL = 120;
const MAX_TARGETS = 100;

export type Connection = { id: string; createdAt: number; targets: DeliveryTarget[] };

export type ConductorStore = {
  /** Begin pairing: a one-time code to type on the Hermes machine. */
  startPairing(now: number): { code: string; expiresAt: number };
  /** Trade a pairing code for a conductor token. One use; null if unknown/expired/used. */
  redeemPairing(code: string, now: number): { connectionId: string; token: string } | null;
  /** The connection id for a token, or null. Constant-time compare on the hash. */
  verifyToken(token: string): string | null;
  /** The active connection, or null if no Hermes is connected. */
  connection(): Connection | null;
  /** Replace the reported messaging targets for a connection. Returns false if malformed. */
  setTargets(connectionId: string, targets: unknown): boolean;
  /** Targets to offer in the editor: the built-in local file, then reported messaging targets. */
  offeredTargets(): DeliveryTarget[];
  /** Disconnect: revoke the active token and forget its targets. */
  revoke(): void;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A short, human-typeable code: 8 chars from an unambiguous alphabet, grouped. */
function newPairingCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no I,L,O,0,1,U
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i += 1) code += alphabet[bytes[i]! % alphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function parseTargets(value: unknown): DeliveryTarget[] | null {
  if (!Array.isArray(value) || value.length > MAX_TARGETS) return null;
  const seen = new Set<string>();
  const targets: DeliveryTarget[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== "string" || t.id === "" || t.id.length > MAX_LABEL) return null;
    if (typeof t.label !== "string" || t.label === "" || t.label.length > MAX_LABEL) return null;
    // The conductor only reports messaging targets; local-file is built in here.
    if (t.kind !== "messaging") return null;
    if (t.id === LOCAL_FILE_TARGET || seen.has(t.id)) return null;
    seen.add(t.id);
    targets.push({ id: t.id, label: t.label, kind: "messaging" });
  }
  return targets;
}

export function createConductorStore(db: DatabaseSync): ConductorStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conductor_connections (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      targets TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      redeemed_at INTEGER
    );
  `);
  const insertCode = db.prepare("INSERT INTO pairing_codes (code_hash, created_at, expires_at, redeemed_at) VALUES (?, ?, ?, NULL)");
  const findCode = db.prepare("SELECT code_hash, expires_at, redeemed_at FROM pairing_codes WHERE code_hash = ?");
  const redeemCode = db.prepare("UPDATE pairing_codes SET redeemed_at = ? WHERE code_hash = ? AND redeemed_at IS NULL AND expires_at > ?");
  const revokeAll = db.prepare("UPDATE conductor_connections SET revoked_at = ? WHERE revoked_at IS NULL");
  const insertConn = db.prepare("INSERT INTO conductor_connections (id, token_hash, created_at, targets) VALUES (?, ?, ?, '[]')");
  const activeConn = db.prepare("SELECT id, created_at, targets FROM conductor_connections WHERE revoked_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1");
  const connByHash = db.prepare("SELECT id FROM conductor_connections WHERE token_hash = ? AND revoked_at IS NULL");
  const updateTargets = db.prepare("UPDATE conductor_connections SET targets = ? WHERE id = ? AND revoked_at IS NULL");

  function activeConnection(): { id: string; created_at: number; targets: string } | null {
    return (activeConn.get() as { id: string; created_at: number; targets: string } | undefined) ?? null;
  }

  return {
    startPairing(now) {
      const code = newPairingCode();
      insertCode.run(sha256(code), now, now + PAIRING_TTL_MS);
      return { code, expiresAt: now + PAIRING_TTL_MS };
    },
    redeemPairing(code, now) {
      if (typeof code !== "string" || code.length === 0 || code.length > 32) return null;
      const hash = sha256(code);
      const row = findCode.get(hash) as { redeemed_at: number | null; expires_at: number } | undefined;
      if (!row) return null;
      const result = redeemCode.run(now, hash, now);
      if (Number(result.changes) === 0) return null; // already used or expired
      // One Hermes at a time: redeeming a code revokes any prior connection.
      revokeAll.run(now);
      const token = randomBytes(32).toString("hex");
      const connectionId = randomUUID();
      insertConn.run(connectionId, sha256(token), now);
      return { connectionId, token };
    },
    verifyToken(token) {
      if (typeof token !== "string" || token.length < 32 || token.length > 128) return null;
      const row = connByHash.get(sha256(token)) as { id: string } | undefined;
      if (!row) return null;
      // Constant-time confirm that the stored id maps back (defensive; hash lookup already matched).
      const a = Buffer.from(row.id);
      return timingSafeEqual(a, a) ? row.id : null;
    },
    connection() {
      const row = activeConnection();
      if (!row) return null;
      let targets: DeliveryTarget[] = [];
      try {
        targets = JSON.parse(row.targets) as DeliveryTarget[];
      } catch {
        targets = [];
      }
      return { id: row.id, createdAt: row.created_at, targets };
    },
    setTargets(connectionId, targets) {
      const parsed = parseTargets(targets);
      if (!parsed) return false;
      const result = updateTargets.run(JSON.stringify(parsed), connectionId);
      return Number(result.changes) > 0;
    },
    offeredTargets() {
      const local: DeliveryTarget = { id: LOCAL_FILE_TARGET, label: "Write to a local file", kind: "local-file" };
      const conn = this.connection();
      return [local, ...(conn?.targets ?? [])];
    },
    revoke() {
      revokeAll.run(Date.now());
    },
  };
}
