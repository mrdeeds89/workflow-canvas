import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openStore } from "../graph/store.ts";
import { loadHarnessConfig } from "../harness/config.ts";
import { createApp } from "./server.ts";

/**
 * Entry point for the private design-time API.
 *
 * Binds to loopback unless WORKFLOW_CANVAS_HOST is set explicitly. This service
 * has no authentication, so it must not be bound to a public interface.
 */

const host = process.env.WORKFLOW_CANVAS_HOST ?? "127.0.0.1";
const port = Number(process.env.WORKFLOW_CANVAS_PORT ?? 8787);
const dbPath = resolve(process.env.WORKFLOW_CANVAS_DB ?? "data/canvas.sqlite");
const allowedOrigins = (process.env.WORKFLOW_CANVAS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin !== "");
// The built canvas UI (`npm run build`). Without it the service is API-only.
const staticCandidate = resolve(process.env.WORKFLOW_CANVAS_STATIC ?? "dist/web");
const staticDir = existsSync(join(staticCandidate, "index.html")) ? staticCandidate : undefined;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error(`Invalid WORKFLOW_CANVAS_PORT: ${process.env.WORKFLOW_CANVAS_PORT}`);
  process.exit(1);
}

// Private file naming the Hermes harnesses this server may observe. Never in the repository.
const harnessConfig = loadHarnessConfig(process.env.WORKFLOW_CANVAS_HARNESS_CONFIG);

mkdirSync(dirname(dbPath), { recursive: true });

const store = openStore(dbPath);
const server = createApp({ store, allowedOrigins, staticDir, harnessConfig });

server.listen(port, host, () => {
  console.log(`workflow-canvas API listening on http://${host}:${port}`);
  console.log(`database: ${dbPath}`);
  console.log(staticDir ? `canvas UI: ${staticDir}` : `canvas UI: not built (${staticCandidate} missing), API only`);
  console.log(
    allowedOrigins.length > 0
      ? `allowed browser origins: ${allowedOrigins.join(", ")}`
      : "allowed browser origins: none (non-browser clients only)",
  );
  console.log(
    harnessConfig.harnesses.length > 0
      ? `observed harnesses (read-only): ${harnessConfig.harnesses.map((item) => `${item.label} [${item.profiles.join(", ")}]`).join("; ")}`
      : "observed harnesses: none",
  );
  console.log("execution: disabled by design");
});

function shutdown(signal: string): void {
  console.log(`\n${signal} received, closing.`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
