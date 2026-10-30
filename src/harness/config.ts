import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DEFAULT_THRESHOLDS, LABEL_PATTERN, type Thresholds } from "./observation.ts";

/**
 * Which harnesses this server may observe, and how.
 *
 * Lives in a private JSON file named by WORKFLOW_CANVAS_HARNESS_CONFIG, never
 * in the repository. Requests name a harness and profile by label only. Host,
 * user, and key paths stay here, are never returned by the API, and cannot be
 * supplied by a request.
 */

export type SshTarget = {
  transport: "ssh";
  host: string;
  port: number;
  user: string;
  knownHostsFile: string;
  identityFile: string;
};

/** Reads `<directory>/<profile>/<jobId>.json`. For examples and tests, not a real harness. */
export type FixtureTarget = {
  transport: "fixture-dir";
  directory: string;
  /** Shift every timestamp so observed_at becomes the moment of the pull. Labelled in provenance. */
  shiftTimesToNow: boolean;
  exampleJobs: string[];
};

export type Target = (SshTarget | FixtureTarget) & { harness: string; profile: string };

export type HarnessConfig = {
  thresholds: Thresholds;
  minRefreshMs: number;
  harnesses: { label: string; profiles: string[]; exampleJobs: string[] }[];
  target(harness: string, profile: string): Target | null;
};

export const EMPTY_CONFIG: HarnessConfig = {
  thresholds: DEFAULT_THRESHOLDS,
  minRefreshMs: 60_000,
  harnesses: [],
  target: () => null,
};

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

class ConfigError extends Error {}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function label(value: unknown, path: string): string {
  if (typeof value !== "string" || !LABEL_PATTERN.test(value)) {
    throw new ConfigError(`${path} must be a lowercase label (letters, digits, - and _)`);
  }
  return value;
}

function absolutePath(value: unknown, path: string, base: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) throw new ConfigError(`${path} must be a path`);
  return isAbsolute(value) ? value : resolve(base, value);
}

function positive(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ConfigError(`${path} must be a number of 0 or more`);
  return value;
}

/** Parse a harness config. Relative paths resolve against the config file's directory. */
export function parseHarnessConfig(value: unknown, base: string): HarnessConfig {
  const raw = obj(value, "config");
  const thresholds: Thresholds = {
    staleAfterMs: positive(raw.staleAfterMinutes, DEFAULT_THRESHOLDS.staleAfterMs / 60_000, "staleAfterMinutes") * 60_000,
    heartbeatSilentS: positive(raw.heartbeatSilentSeconds, DEFAULT_THRESHOLDS.heartbeatSilentS, "heartbeatSilentSeconds"),
  };
  const minRefreshMs = positive(raw.minRefreshSeconds, 60, "minRefreshSeconds") * 1000;
  if (!Array.isArray(raw.harnesses)) throw new ConfigError("harnesses must be a list");

  const targets = new Map<string, Target>();
  const summary: HarnessConfig["harnesses"] = [];
  raw.harnesses.forEach((entry, index) => {
    const path = `harnesses[${index}]`;
    const harness = obj(entry, path);
    const name = label(harness.label, `${path}.label`);
    if (summary.some((item) => item.label === name)) throw new ConfigError(`${path}.label "${name}" is used twice`);
    const profiles = obj(harness.profiles, `${path}.profiles`);
    const names = Object.keys(profiles).map((profile) => label(profile, `${path}.profiles key`));
    if (names.length === 0) throw new ConfigError(`${path}.profiles must name at least one profile`);

    let exampleJobs: string[] = [];
    if (harness.transport === "ssh") {
      if (typeof harness.host !== "string" || !HOST_PATTERN.test(harness.host)) throw new ConfigError(`${path}.host is not a host name or address`);
      if (typeof harness.user !== "string" || !USER_PATTERN.test(harness.user)) throw new ConfigError(`${path}.user is not a user name`);
      const port = harness.port === undefined ? 22 : harness.port;
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) throw new ConfigError(`${path}.port is not a port`);
      const knownHostsFile = absolutePath(harness.knownHostsFile, `${path}.knownHostsFile`, base);
      for (const profile of names) {
        const settings = obj(profiles[profile], `${path}.profiles.${profile}`);
        targets.set(`${name}/${profile}`, {
          transport: "ssh",
          harness: name,
          profile,
          host: harness.host,
          port,
          user: harness.user,
          knownHostsFile,
          identityFile: absolutePath(settings.identityFile, `${path}.profiles.${profile}.identityFile`, base),
        });
      }
    } else if (harness.transport === "fixture-dir") {
      const directory = absolutePath(harness.directory, `${path}.directory`, base);
      exampleJobs = Array.isArray(harness.exampleJobs)
        ? harness.exampleJobs.filter((id): id is string => typeof id === "string" && /^[0-9a-f]{6,32}$/.test(id))
        : [];
      for (const profile of names) {
        targets.set(`${name}/${profile}`, {
          transport: "fixture-dir",
          harness: name,
          profile,
          directory,
          shiftTimesToNow: harness.shiftTimesToNow === true,
          exampleJobs,
        });
      }
    } else {
      throw new ConfigError(`${path}.transport must be "ssh" or "fixture-dir"`);
    }
    summary.push({ label: name, profiles: names, exampleJobs });
  });

  return {
    thresholds,
    minRefreshMs,
    harnesses: summary,
    target: (harness, profile) => targets.get(`${harness}/${profile}`) ?? null,
  };
}

/** Load the config named by the environment, or none. A broken file stops startup. */
export function loadHarnessConfig(path: string | undefined): HarnessConfig {
  if (path === undefined || path.trim() === "") return EMPTY_CONFIG;
  const file = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Harness config ${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseHarnessConfig(parsed, dirname(file));
  } catch (error) {
    if (error instanceof ConfigError) throw new Error(`Harness config ${file} is not valid: ${error.message}`);
    throw error;
  }
}
