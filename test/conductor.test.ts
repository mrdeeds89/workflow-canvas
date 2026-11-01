import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PAIRING_TTL_MS, createConductorStore } from "../src/graph/conductor.ts";
import { LOCAL_FILE_TARGET } from "../src/graph/types.ts";

function freshStore() {
  return createConductorStore(new DatabaseSync(":memory:"));
}

test("a pairing code can be redeemed once for a token that then verifies", () => {
  const store = freshStore();
  const { code } = store.startPairing(1000);
  const redeemed = store.redeemPairing(code, 1500);
  assert.ok(redeemed, "the fresh code redeems");
  assert.equal(store.verifyToken(redeemed!.token), redeemed!.connectionId);
  // Same code again: refused.
  assert.equal(store.redeemPairing(code, 1600), null);
});

test("an expired pairing code is refused", () => {
  const store = freshStore();
  const { code } = store.startPairing(1000);
  assert.equal(store.redeemPairing(code, 1000 + PAIRING_TTL_MS + 1), null);
});

test("an unknown or malformed token does not verify", () => {
  const store = freshStore();
  const { code } = store.startPairing(1000);
  store.redeemPairing(code, 1100);
  assert.equal(store.verifyToken("not-a-real-token"), null);
  assert.equal(store.verifyToken(""), null);
  assert.equal(store.verifyToken("x".repeat(64)), null);
});

test("pairing a new Hermes revokes the previous connection's token", () => {
  const store = freshStore();
  const first = store.redeemPairing(store.startPairing(1000).code, 1100)!;
  assert.equal(store.verifyToken(first.token), first.connectionId);
  const second = store.redeemPairing(store.startPairing(2000).code, 2100)!;
  assert.equal(store.verifyToken(first.token), null, "the old token stops working");
  assert.equal(store.verifyToken(second.token), second.connectionId);
});

test("offered targets always start with the built-in local file", () => {
  const store = freshStore();
  assert.deepEqual(store.offeredTargets(), [{ id: LOCAL_FILE_TARGET, label: "Write to a local file", kind: "local-file" }]);
  const conn = store.redeemPairing(store.startPairing(1000).code, 1100)!;
  assert.equal(store.setTargets(conn.connectionId, [{ id: "telegram:7", label: "Telegram · Briefings", kind: "messaging" }]), true);
  const offered = store.offeredTargets();
  assert.equal(offered[0]!.id, LOCAL_FILE_TARGET);
  assert.deepEqual(offered.map((t) => t.id), [LOCAL_FILE_TARGET, "telegram:7"]);
});

test("malformed or spoofed targets are refused", () => {
  const store = freshStore();
  const conn = store.redeemPairing(store.startPairing(1000).code, 1100)!;
  assert.equal(store.setTargets(conn.connectionId, "nope"), false);
  assert.equal(store.setTargets(conn.connectionId, [{ id: "x", label: "y", kind: "local-file" }]), false, "only messaging targets are reported");
  assert.equal(store.setTargets(conn.connectionId, [{ id: LOCAL_FILE_TARGET, label: "spoof", kind: "messaging" }]), false, "cannot shadow the built-in local file");
  assert.equal(store.setTargets(conn.connectionId, [{ id: "a", label: "A", kind: "messaging" }, { id: "a", label: "A2", kind: "messaging" }]), false, "no duplicate ids");
  assert.equal(store.setTargets("no-such-connection", [{ id: "a", label: "A", kind: "messaging" }]), false);
});

test("a revoked connection offers only the local file and verifies no token", () => {
  const store = freshStore();
  const conn = store.redeemPairing(store.startPairing(1000).code, 1100)!;
  store.setTargets(conn.connectionId, [{ id: "telegram:7", label: "T", kind: "messaging" }]);
  store.revoke();
  assert.equal(store.verifyToken(conn.token), null);
  assert.equal(store.connection(), null);
  assert.deepEqual(store.offeredTargets().map((t) => t.id), [LOCAL_FILE_TARGET]);
});
