import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROFILE_NAMES, PROFILES } from "./profiles.js";

export type Tier = "pass" | "undoable" | "hold";

export interface ServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Name of a built-in rule pack (see src/profiles.ts) applied to this server. */
  profile?: string;
}

export interface PolicyRule {
  /** Tool-name pattern: `|`-separated globs, `*` wildcard, case-insensitive. */
  match: string;
  /** Optional downstream server name this rule is scoped to. */
  server?: string;
  tier: Tier;
}

/**
 * `block`: a held tool call waits and resolves to the real downstream result
 * once a human commits — so the outcome flows straight back into the LLM call.
 * `async`: a held call returns a notice immediately; the agent retrieves the
 * result later via recoil_status (for hosts that can't hold a call open).
 */
export type HoldMode = "block" | "async";

export interface RecoilConfig {
  servers: Record<string, ServerSpec>;
  rules: PolicyRule[];
  defaultTier: Tier;
  commitWindowMs: number;
  allowAgentCommit: boolean;
  maxSnapshotBytes: number;
  dataDir: string;
  holdMode: HoldMode;
  /** In block mode, give up waiting after this many ms (0 = wait indefinitely). */
  holdTimeoutMs: number;
  /** In block mode, emit a progress keepalive this often while waiting. */
  holdProgressMs: number;
  /** Web console port (0 = off). Bound to loopback. */
  controlPort: number;
  controlHost: string;
}

export const DEFAULTS = {
  rules: [] as PolicyRule[],
  defaultTier: "undoable" as Tier,
  commitWindowMs: 30 * 60 * 1000,
  allowAgentCommit: false,
  maxSnapshotBytes: 50 * 1024 * 1024,
  dataDir: ".recoil",
  holdMode: "block" as HoldMode,
  holdTimeoutMs: 0,
  holdProgressMs: 10 * 1000,
  controlPort: 7777,
  controlHost: "127.0.0.1",
};

export function loadConfig(path: string): RecoilConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw.servers || Object.keys(raw.servers).length === 0) {
    throw new Error(`${path}: "servers" must list at least one downstream MCP server`);
  }
  for (const [name, spec] of Object.entries(raw.servers as Record<string, ServerSpec>)) {
    if (spec.profile && !PROFILES[spec.profile]) {
      throw new Error(`${path}: server "${name}" has unknown profile "${spec.profile}" (built-in: ${PROFILE_NAMES.join(", ")})`);
    }
  }
  const tiers: Tier[] = ["pass", "undoable", "hold"];
  for (const rule of raw.rules ?? []) {
    if (!rule.match || !tiers.includes(rule.tier)) {
      throw new Error(`${path}: bad rule ${JSON.stringify(rule)} — needs "match" and tier pass|undoable|hold`);
    }
  }
  if (raw.defaultTier && !tiers.includes(raw.defaultTier)) {
    throw new Error(`${path}: defaultTier must be pass|undoable|hold`);
  }
  if (raw.holdMode && raw.holdMode !== "block" && raw.holdMode !== "async") {
    throw new Error(`${path}: holdMode must be block|async`);
  }
  return {
    servers: raw.servers,
    rules: raw.rules ?? DEFAULTS.rules,
    defaultTier: raw.defaultTier ?? DEFAULTS.defaultTier,
    commitWindowMs: raw.commitWindowMs ?? DEFAULTS.commitWindowMs,
    allowAgentCommit: raw.allowAgentCommit ?? DEFAULTS.allowAgentCommit,
    maxSnapshotBytes: raw.maxSnapshotBytes ?? DEFAULTS.maxSnapshotBytes,
    dataDir: resolve(raw.dataDir ?? DEFAULTS.dataDir),
    holdMode: raw.holdMode ?? DEFAULTS.holdMode,
    holdTimeoutMs: raw.holdTimeoutMs ?? DEFAULTS.holdTimeoutMs,
    holdProgressMs: raw.holdProgressMs ?? DEFAULTS.holdProgressMs,
    controlPort: raw.controlPort ?? DEFAULTS.controlPort,
    controlHost: raw.controlHost ?? DEFAULTS.controlHost,
  };
}
