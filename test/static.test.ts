import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore } from "../src/graph/store.ts";
import { CONTENT_SECURITY_POLICY, createApp } from "../src/http/server.ts";

type Raw = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/**
 * Send a request path exactly as written. fetch() would normalise `..`
 * segments away before they reached the server, hiding traversal bugs.
 */
function raw(port: number, path: string, method = "GET"): Promise<Raw> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", fail);
    req.end();
  });
}

async function withStaticServer(run: (port: number) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wc-static-"));
  const web = join(dir, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>Workflow Canvas</title>");
  writeFileSync(join(web, "assets", "app-abc123.js"), "console.log('canvas');");
  // Sits next to the served root; nothing may reach it.
  writeFileSync(join(dir, "secret.txt"), "outside the web root");

  const store = openStore(join(dir, "canvas.sqlite"));
  const server = createApp({ store, staticDir: web });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  try {
    await run(port);
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("serves the canvas page with a script-restricting policy", async () => {
  await withStaticServer(async (port) => {
    const page = await raw(port, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /Workflow Canvas/);
    assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(page.headers["content-security-policy"], CONTENT_SECURITY_POLICY);
    assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'(;|$)/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["cache-control"], "no-cache");
  });
});

test("serves fingerprinted assets as immutable with the right type", async () => {
  await withStaticServer(async (port) => {
    const asset = await raw(port, "/assets/app-abc123.js");
    assert.equal(asset.status, 200);
    assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8");
    assert.match(String(asset.headers["cache-control"]), /immutable/);
  });
});

test("falls back to the page for extensionless paths but 404s missing files", async () => {
  await withStaticServer(async (port) => {
    const route = await raw(port, "/some/canvas/route");
    assert.equal(route.status, 200);
    assert.match(route.body, /Workflow Canvas/);
    assert.equal((await raw(port, "/assets/missing.js")).status, 404);
  });
});

test("refuses every path that would escape the web root", async () => {
  await withStaticServer(async (port) => {
    for (const path of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/%2e%2e%2fsecret.txt",
    ]) {
      const response = await raw(port, path);
      assert.notEqual(response.status, 200, `${path} must not be served`);
      assert.doesNotMatch(response.body, /outside the web root/, `${path} leaked a file`);
    }
    assert.equal((await raw(port, "/%00index.html")).status, 400);
  });
});

test("only reads static files; writes and API routes keep their own rules", async () => {
  await withStaticServer(async (port) => {
    const post = await raw(port, "/index.html", "POST");
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, "GET, HEAD");
    assert.equal((await raw(port, "/api/nope")).status, 404);
    assert.equal((await raw(port, "/api/health")).status, 200);
  });
});
