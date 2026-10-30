import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openStore, type WorkflowStore } from "../src/graph/store.ts";
import { parseHarnessConfig, type HarnessConfig, type Target } from "../src/harness/config.ts";
import { classifySshFailure, defaultSource, shiftTimes, sshArgs, type FetchResult, type ObservationSource } from "../src/harness/source.ts";
import { createApp } from "../src/http/server.ts";
import { card, setupTask } from "./fixtures.ts";

const REPO = join(import.meta.dirname, "..");
const EXAMPLES = join(REPO, "examples", "hermes-observations");
const DIGEST = "a1b2c3d4e5f6";
const DISK = "b2c3d4e5f6a7";

function exampleText(id: string): string {
  return readFileSync(join(EXAMPLES, "example", `${id}.json`), "utf8");
}

const CONFIG = parseHarnessConfig(
  {
    minRefreshSeconds: 60,
    harnesses: [
      {
        label: "lab",
        transport: "ssh",
        host: "harness.example.lan",
        user: "hermes",
        knownHostsFile: "/private/known_hosts",
        profiles: { example: { identityFile: "/private/keys/example" }, other: { identityFile: "/private/keys/other" } },
      },
    ],
  },
  "/",
);

type Calls = { target: Target; jobId: string }[];

type Context = {
  base: string;
  store: WorkflowStore;
  calls: Calls;
  clock: { now: number };
  reply: { next: (jobId: string) => FetchResult | Promise<FetchResult> };
  dir: string;
};

async function withServer(run: (context: Context) => Promise<void>, config: HarnessConfig = CONFIG, keepDir?: string): Promise<void> {
  const dir = keepDir ?? mkdtempSync(join(tmpdir(), "wc-harness-"));
  const store = openStore(join(dir, "canvas.sqlite"));
  const calls: Calls = [];
  const clock = { now: Date.parse("2026-10-30T12:00:00Z") };
  const reply: Context["reply"] = {
    next: (jobId) => ({ ok: true, raw: exampleText(jobId === DISK ? DISK : DIGEST), source: "ssh-pull" }),
  };
  const source: ObservationSource = async (target, jobId) => {
    calls.push({ target, jobId });
    return reply.next(jobId);
  };
  const server = createApp({ store, harnessConfig: config, observationSource: source, now: () => clock.now });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ base: `http://127.0.0.1:${port}`, store, calls, clock, reply, dir });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
    if (!keepDir) rmSync(dir, { recursive: true, force: true });
  }
}

function send(base: string, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function workflow(base: string): Promise<{ id: string; text: string }> {
  const created = (await (await send(base, "POST", "/api/workflows", { title: "Linked" })).json()) as Record<string, unknown>;
  const doc = { ...created, nodes: [card("c1", { readiness: "not_configured", setup: [setupTask("s1", { done: true })] })] };
  const saved = await send(base, "PUT", `/api/workflows/${created.id as string}`, doc);
  assert.equal(saved.status, 200);
  const id = created.id as string;
  return { id, text: await (await fetch(`${base}/api/workflows/${id}`)).text() };
}

async function link(base: string, id: string, jobId = DIGEST, profile = "example") {
  return send(base, "PUT", `/api/workflows/${id}/harness-link`, { harness: "lab", profile, jobId });
}

test("harness list returns labels and profiles, never hosts, users or key paths", async () => {
  await withServer(async ({ base }) => {
    const text = await (await fetch(`${base}/api/harnesses`)).text();
    assert.deepEqual(JSON.parse(text), { harnesses: [{ label: "lab", profiles: ["example", "other"], exampleJobs: [] }] });
    for (const secret of ["harness.example.lan", "hermes", "/private"]) assert.ok(!text.includes(secret), secret);
  });
});

test("linking validates harness, profile, job id and workflow", async () => {
  await withServer(async ({ base }) => {
    const { id } = await workflow(base);
    const bad: [unknown, number, string][] = [
      [{ harness: "nope", profile: "example", jobId: DIGEST }, 422, "unknown_harness"],
      [{ harness: "lab", profile: "missing", jobId: DIGEST }, 422, "unknown_harness"],
      [{ harness: "lab", profile: "example", jobId: "../../etc/passwd" }, 422, "invalid_job_id"],
      [{ harness: "lab", profile: "example", jobId: "snapshot abc; id" }, 422, "invalid_job_id"],
      [{ harness: "LAB; rm", profile: "example", jobId: DIGEST }, 422, "invalid"],
    ];
    for (const [body, status, code] of bad) {
      const response = await send(base, "PUT", `/api/workflows/${id}/harness-link`, body);
      assert.equal(response.status, status, JSON.stringify(body));
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, code);
    }
    assert.equal((await link(base, "no-such-workflow")).status, 404);
    assert.equal((await send(base, "PUT", `/api/workflows/${id}/harness-link`, "nope")).status, 400);
  });
});

test("link, refresh and unlink never change the workflow document or its revision", async () => {
  await withServer(async ({ base, clock }) => {
    const { id, text } = await workflow(base);
    assert.equal((await link(base, id)).status, 200);
    clock.now += 1000;
    assert.equal((await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`)).status, 200);
    assert.equal(await (await fetch(`${base}/api/workflows/${id}`)).text(), text);
    assert.equal((await send(base, "DELETE", `/api/workflows/${id}/harness-link`)).status, 204);
    assert.equal(await (await fetch(`${base}/api/workflows/${id}`)).text(), text);
  });
});

test("an ok observation leaves card readiness alone and tested is still refused", async () => {
  await withServer(async ({ base, clock }) => {
    const { id } = await workflow(base);
    await link(base, id);
    clock.now += 1000;
    await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`);
    const doc = (await (await fetch(`${base}/api/workflows/${id}`)).json()) as { nodes: { readiness: string }[] };
    assert.equal(doc.nodes[0]?.readiness, "configured");
    const claim = { ...doc, nodes: doc.nodes.map((node) => ({ ...node, readiness: "tested" })) };
    const response = await send(base, "PUT", `/api/workflows/${id}`, claim);
    assert.equal(response.status, 422);
  });
});

test("refresh sends only the configured target and the linked job id to the source", async () => {
  await withServer(async ({ base, calls, clock }) => {
    const { id } = await workflow(base);
    await link(base, id);
    clock.now += 1000;
    const view = (await (await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`)).json()) as Record<string, unknown>;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.jobId, DIGEST);
    assert.equal(calls[0]?.target.transport, "ssh");
    assert.equal(calls[0]?.target.profile, "example");
    const text = JSON.stringify(view);
    for (const secret of ["harness.example.lan", "/private"]) assert.ok(!text.includes(secret), secret);
    const latest = view.latestJob as { observation: { job: { jobId: string } }; source: string };
    assert.equal(latest.observation.job.jobId, DIGEST);
    assert.equal(latest.source, "ssh-pull");
    assert.equal((view.link as { linkedFingerprint: string }).linkedFingerprint, "1".repeat(64));
  });
});

test("refresh is rate limited per workflow", async () => {
  await withServer(async ({ base, calls, clock }) => {
    const { id } = await workflow(base);
    await link(base, id);
    assert.equal((await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`)).status, 200);
    clock.now += 5_000;
    const second = await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`);
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after"), "55");
    clock.now += 60_000;
    assert.equal((await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`)).status, 200);
    assert.equal(calls.length, 2);
  });
});

test("re-linking, or a second workflow on the same job, cannot bypass the rate limit", async () => {
  await withServer(async ({ base, calls, clock }) => {
    const { id } = await workflow(base);
    const { id: other } = await workflow(base);
    await link(base, id);
    assert.equal((await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`)).status, 200);
    clock.now += 1000;
    await send(base, "DELETE", `/api/workflows/${id}/harness-link`);
    await link(base, id);
    assert.equal((await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`)).status, 429);
    await link(base, other);
    assert.equal((await send(base, "POST", `/api/workflows/${other}/harness-link/refresh`)).status, 429);
    assert.equal(calls.length, 1);
  });
});

test("a corrupt stored observation is treated as absent, not a server error", async () => {
  await withServer(async ({ base, dir }) => {
    const { id } = await workflow(base);
    await link(base, id);
    await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`);
    const db = new DatabaseSync(join(dir, "canvas.sqlite"));
    try {
      assert.equal(db.prepare("UPDATE harness_observations SET payload = '{not json'").run().changes, 1);
    } finally {
      db.close();
    }
    const response = await fetch(`${base}/api/workflows/${id}/harness`);
    assert.equal(response.status, 200);
    const view = (await response.json()) as { link: { jobId: string }; latestJob: unknown; latestAny: unknown };
    assert.equal(view.link.jobId, DIGEST);
    assert.equal(view.latestJob, null);
    assert.equal(view.latestAny, null);
  });
});

test("an observation that does not name the linked profile is refused", async () => {
  await withServer(async ({ base, reply }) => {
    const { id } = await workflow(base);
    await link(base, id);
    reply.next = () => ({ ok: true, raw: exampleText(DIGEST).replace('"profile": "example"', '"profile": null'), source: "ssh-pull" });
    const view = (await (await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`)).json()) as {
      link: { lastAttemptOutcome: string };
      latestAny: unknown;
    };
    assert.equal(view.link.lastAttemptOutcome, "bad_output");
    assert.equal(view.latestAny, null);
  });
});

test("two refreshes at once make one pull", async () => {
  await withServer(async ({ base, calls, reply }) => {
    const { id } = await workflow(base);
    await link(base, id);
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => (release = done));
    reply.next = async () => {
      await gate;
      return { ok: true, raw: exampleText(DIGEST), source: "ssh-pull" };
    };
    const first = send(base, "POST", `/api/workflows/${id}/harness-link/refresh`);
    await new Promise((done) => setTimeout(done, 50));
    const second = send(base, "POST", `/api/workflows/${id}/harness-link/refresh`);
    await new Promise((done) => setTimeout(done, 50));
    release();
    assert.deepEqual([(await first).status, (await second).status], [200, 200]);
    assert.equal(calls.length, 1);
  });
});

test("a failed pull is recorded as disconnected and keeps the last observation", async () => {
  await withServer(async ({ base, clock, reply }) => {
    const { id } = await workflow(base);
    await link(base, id);
    await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`);
    reply.next = () => ({ ok: false, outcome: "unreachable" });
    clock.now += 61_000;
    const view = (await (await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`)).json()) as {
      link: { lastAttemptOutcome: string };
      latestJob: { receivedAt: number } | null;
    };
    assert.equal(view.link.lastAttemptOutcome, "unreachable");
    assert.equal(view.latestJob?.receivedAt, Date.parse("2026-10-30T12:00:00Z"));
  });
});

test("bad output, a mismatched job, or a mismatched profile is never stored", async () => {
  const replies: [string, FetchResult][] = [
    ["not json", { ok: true, raw: "hello", source: "ssh-pull" }],
    ["wrong format", { ok: true, raw: JSON.stringify({ format: "x" }), source: "ssh-pull" }],
    ["another job", { ok: true, raw: exampleText(DISK), source: "ssh-pull" }],
    ["another profile", { ok: true, raw: exampleText(DIGEST).replace('"profile": "example"', '"profile": "other"'), source: "ssh-pull" }],
  ];
  for (const [name, answer] of replies) {
    await withServer(async ({ base, reply }) => {
      const { id } = await workflow(base);
      await link(base, id);
      reply.next = () => answer;
      const view = (await (await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`)).json()) as {
        link: { lastAttemptOutcome: string };
        latestAny: unknown;
      };
      assert.equal(view.link.lastAttemptOutcome, "bad_output", name);
      assert.equal(view.latestAny, null, name);
    });
  }
});

test("re-linking to another job drops evidence about the old one", async () => {
  await withServer(async ({ base, clock }) => {
    const { id } = await workflow(base);
    await link(base, id, DIGEST);
    await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`);
    const relinked = (await (await link(base, id, DISK)).json()) as { latestAny: unknown; link: { jobId: string } };
    assert.equal(relinked.link.jobId, DISK);
    assert.equal(relinked.latestAny, null);
    clock.now += 1000;
    const view = (await (await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`)).json()) as {
      latestJob: { observation: { job: { jobId: string } } };
    };
    assert.equal(view.latestJob.observation.job.jobId, DISK);
  });
});

test("a pull that finishes after a re-link does not land on the new link", async () => {
  await withServer(async ({ base, reply }) => {
    const { id } = await workflow(base);
    await link(base, id, DIGEST);
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => (release = done));
    reply.next = async () => {
      await gate;
      return { ok: true, raw: exampleText(DIGEST), source: "ssh-pull" };
    };
    const pending = send(base, "POST", `/api/workflows/${id}/harness-link/refresh`);
    await new Promise((done) => setTimeout(done, 50));
    await link(base, id, DISK);
    release();
    const view = (await (await pending).json()) as { link: { jobId: string; lastAttemptOutcome: unknown }; latestAny: unknown };
    assert.equal(view.link.jobId, DISK);
    assert.equal(view.latestAny, null);
    assert.equal(view.link.lastAttemptOutcome, null);
  });
});

test("deleting a workflow removes its link and evidence; duplicating does not copy them", async () => {
  await withServer(async ({ base, store }) => {
    const { id } = await workflow(base);
    await link(base, id);
    await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`);
    const copy = (await (await send(base, "POST", `/api/workflows/${id}/duplicate`)).json()) as { id: string };
    assert.equal(store.harness.link(copy.id), null);
    assert.equal((await send(base, "DELETE", `/api/workflows/${id}`)).status, 204);
    assert.equal(store.harness.link(id), null);
    assert.equal(store.harness.latest(id).any, null);
  });
});

test("link and observations survive a restart on the same database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wc-harness-restart-"));
  let id = "";
  try {
    await withServer(
      async ({ base }) => {
        id = (await workflow(base)).id;
        await link(base, id);
        await send(base, "POST", `/api/workflows/${id}/harness-link/refresh`);
      },
      CONFIG,
      dir,
    );
    await withServer(
      async ({ base, clock }) => {
        clock.now += 20 * 60_000;
        const view = (await (await fetch(`${base}/api/workflows/${id}/harness`)).json()) as {
          link: { jobId: string };
          latestJob: { receivedAt: number };
          serverNow: number;
        };
        assert.equal(view.link.jobId, DIGEST);
        assert.equal(view.serverNow - view.latestJob.receivedAt, 20 * 60_000, "age comes from stored times, not uptime");
      },
      CONFIG,
      dir,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no route can pause, resume, run, edit, create or delete a Hermes job", async () => {
  await withServer(async ({ base, calls }) => {
    const { id } = await workflow(base);
    await link(base, id);
    const paths = [
      `/api/workflows/${id}/harness-link/run`,
      `/api/workflows/${id}/harness-link/pause`,
      `/api/workflows/${id}/harness-link/resume`,
      `/api/workflows/${id}/harness-link/trigger`,
      `/api/workflows/${id}/harness/run`,
      "/api/harnesses/lab/jobs",
      "/api/jobs",
      "/api/cron/jobs",
    ];
    for (const path of paths) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await send(base, method, path, {});
        assert.equal(response.status, 404, `${method} ${path}`);
      }
    }
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      assert.equal((await send(base, method, `/api/workflows/${id}/harness-link/refresh`)).status, 405, method);
    }
    assert.equal((await send(base, "POST", "/api/harnesses", {})).status, 405);
    assert.equal(calls.length, 0, "nothing reached the harness");
  });
});

test("the harness routes refuse an unlisted browser origin", async () => {
  await withServer(async ({ base, calls }) => {
    const { id } = await workflow(base);
    const response = await fetch(`${base}/api/workflows/${id}/harness-link/refresh`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
  });
});

test("ssh arguments are fixed, shell-free, and strict about host keys", () => {
  const target = CONFIG.target("lab", "example");
  assert.ok(target && target.transport === "ssh");
  const args = sshArgs(target, DIGEST);
  assert.deepEqual(args.slice(-3), ["--", "harness.example.lan", `snapshot ${DIGEST}`]);
  for (const option of ["BatchMode=yes", "StrictHostKeyChecking=yes", "IdentitiesOnly=yes", "ClearAllForwardings=yes", "RequestTTY=no"]) {
    assert.ok(args.includes(option), option);
  }
  assert.ok(args.includes("/private/keys/example"));
  assert.throws(() => sshArgs(target, "abc; id"));
  assert.equal(classifySshFailure(255, "Permission denied (publickey).", false), "auth_refused");
  assert.equal(classifySshFailure(255, "Host key verification failed.", false), "host_key_mismatch");
  assert.equal(classifySshFailure(255, "ssh: connect to host x port 22: No route to host", false), "unreachable");
  assert.equal(classifySshFailure(null, "", true), "timeout");
});

test("config refuses hosts and users that could become ssh options", () => {
  const harness = (over: Record<string, unknown>) => ({
    harnesses: [
      { label: "lab", transport: "ssh", host: "h.lan", user: "u", knownHostsFile: "/k", profiles: { p: { identityFile: "/i" } }, ...over },
    ],
  });
  assert.throws(() => parseHarnessConfig(harness({ host: "-oProxyCommand=id" }), "/"));
  assert.throws(() => parseHarnessConfig(harness({ user: "-oProxyCommand=id" }), "/"));
  assert.throws(() => parseHarnessConfig(harness({ host: "a b" }), "/"));
  assert.throws(() => parseHarnessConfig(harness({ transport: "http" }), "/"));
  assert.throws(() => parseHarnessConfig(harness({ profiles: {} }), "/"));
  assert.throws(() => parseHarnessConfig(harness({ label: "Lab" }), "/"));
  const relative = parseHarnessConfig(harness({ knownHostsFile: "known_hosts" }), "/srv/private");
  const target = relative.target("lab", "p");
  assert.ok(target && target.transport === "ssh");
  assert.equal(target.knownHostsFile, "/srv/private/known_hosts");
});

test("example fixtures load through the fixture transport, with shifted times labelled", async () => {
  const config = parseHarnessConfig(JSON.parse(readFileSync(join(EXAMPLES, "harness-config.example.json"), "utf8")), EXAMPLES);
  const target = config.target("examples", "example");
  assert.ok(target);
  const now = Date.parse("2027-01-01T00:00:00Z");
  const result = await defaultSource(() => now)(target, DIGEST);
  assert.ok(result.ok);
  const value = JSON.parse(result.raw) as { observed_at: string; job: { next_run_at: string } };
  assert.equal(value.observed_at, "2027-01-01T00:00:00Z");
  assert.equal(Date.parse(value.job.next_run_at) - now, Date.parse("2026-10-31T08:00:00Z") - Date.parse("2026-10-30T12:00:00Z"));
  assert.match(result.source, /shifted/);
  const missing = await defaultSource(() => now)(target, "ffffffffffff");
  assert.ok(missing.ok && JSON.parse(missing.raw).error.code === "not_found");
  assert.deepEqual(config.harnesses[0]?.exampleJobs, ["a1b2c3d4e5f6", "b2c3d4e5f6a7", "c3d4e5f6a7b8"]);
  assert.deepEqual(shiftTimes({ x: 1 }, now), { x: 1 });
});
