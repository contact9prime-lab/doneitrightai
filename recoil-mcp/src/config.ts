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

export interface RecoilConfig {
  servers: Record<string, ServerSpec>;
  rules: PolicyRule[];
  defaultTier: Tier;
  commitWindowMs: number;
  allowAgentCommit: boolean;
  maxSnapshotBytes: number;
  dataDir: string;
}

export const DEFAULTS = {
  rules: [] as PolicyRule[],
  defaultTier: "undoable" as Tier,
  commitWindowMs: 30 * 60 * 1000,
  allowAgentCommit: false,
  maxSnapshotBytes: 50 * 1024 * 1024,
  dataDir: ".recoil",
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
  return {
    servers: raw.servers,
    rules: raw.rules ?? DEFAULTS.rules,
    defaultTier: raw.defaultTier ?? DEFAULTS.defaultTier,
    commitWindowMs: raw.commitWindowMs ?? DEFAULTS.commitWindowMs,
    allowAgentCommit: raw.allowAgentCommit ?? DEFAULTS.allowAgentCommit,
    maxSnapshotBytes: raw.maxSnapshotBytes ?? DEFAULTS.maxSnapshotBytes,
    dataDir: resolve(raw.dataDir ?? DEFAULTS.dataDir),
  };
}
