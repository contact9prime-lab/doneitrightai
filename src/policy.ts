import type { PolicyRule, RecoilConfig, Tier } from "./config.js";
import { PROFILES } from "./profiles.js";

/**
 * Built-in safety net, evaluated after user rules. Read-shaped tools pass,
 * destructive/outbound verbs are held; everything else falls to defaultTier
 * (undoable: act, audit, snapshot when possible).
 */
export const BUILTIN_RULES: PolicyRule[] = [
  {
    match:
      "read*|list*|get*|search*|glob*|grep*|stat*|fetch*|query*|describe*|view*|head*|find*|check*|show*|count*",
    tier: "pass",
  },
  {
    match:
      "delete*|remove*|drop*|destroy*|truncate*|purge*|wipe*|send*|publish*|deploy*|release*|pay*|transfer*|charge*|refund*|cancel*|merge*|force*|reset*|revoke*|terminate*|kill*|execute*|apply*",
    tier: "hold",
  },
];

function patternToRegex(pattern: string): RegExp {
  const parts = pattern
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.replace(/[.+?^${}()[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
  return new RegExp(`^(?:${parts.join("|")})$`, "i");
}

function matches(rule: PolicyRule, server: string, tool: string): boolean {
  if (rule.server && rule.server !== server) return false;
  return patternToRegex(rule.match).test(tool);
}

/**
 * Precedence: user rules, then the server's profile pack, then built-ins,
 * then the default tier.
 */
export function classify(server: string, tool: string, config: RecoilConfig): Tier {
  for (const rule of config.rules) {
    if (matches(rule, server, tool)) return rule.tier;
  }
  const profile = config.servers[server]?.profile;
  for (const rule of profile ? PROFILES[profile] ?? [] : []) {
    if (matches({ ...rule, server: undefined }, server, tool)) return rule.tier;
  }
  for (const rule of BUILTIN_RULES) {
    if (matches(rule, server, tool)) return rule.tier;
  }
  return config.defaultTier;
}
