import type { PolicyRule } from "./config.js";

/**
 * Curated rule packs for popular MCP servers, referenced per server in the
 * config: { "servers": { "gh": { "command": "...", "profile": "github" } } }.
 * Profile rules apply only to the server that declares them, after user
 * rules and before the built-in safety net.
 *
 * Stance: anything that changes state other people can see (a PR, a Slack
 * message, a production row) is held; reads pass; the rest falls through to
 * the default tier. Loosen with a user rule when a hold is too strict.
 */
export const PROFILES: Record<string, PolicyRule[]> = {
  github: [
    { match: "search*|list*|get*|read*|download*|compare*|check*", tier: "pass" },
    {
      match:
        "merge*|close*|delete*|push*|create_or_update*|create_pull*|create_issue*|create_release*|create_repository*|fork*|transfer*|submit*|dismiss*|request*|add_*comment*|update*|edit*|assign*|lock*|unlock*|enable*|disable*|rerun*|dispatch*",
      tier: "hold",
    },
  ],
  supabase: [
    { match: "list*|get*|generate*|search*|fetch*", tier: "pass" },
    {
      match:
        "execute*|apply*|deploy*|delete*|drop*|truncate*|pause*|restore*|reset*|merge*|rebase*|create_project*|create_branch*|update*|insert*|upsert*",
      tier: "hold",
    },
  ],
  postgres: [
    { match: "query|select*|describe*|list*|get*|explain*", tier: "pass" },
    { match: "execute*|insert*|update*|upsert*|delete*|drop*|alter*|create*|truncate*|grant*|revoke*", tier: "hold" },
  ],
  slack: [
    { match: "list*|get*|search*|read*|conversations_history*|users_*", tier: "pass" },
    { match: "send*|post*|chat_*|reply*|react*|upload*|invite*|kick*|archive*|set*|update*|delete*", tier: "hold" },
  ],
  gmail: [
    { match: "list*|get*|search*|read*|fetch*", tier: "pass" },
    { match: "send*|delete*|trash*|modify*|create_draft*|update*|batch*|archive*|move*|label*", tier: "hold" },
  ],
};

export const PROFILE_NAMES = Object.keys(PROFILES);
