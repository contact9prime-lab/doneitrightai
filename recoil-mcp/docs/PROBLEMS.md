# The Problem Map

What is actually broken in today's open-source personal agentic assistants,
with sources. Researched 2026-06-09. These are the failure modes doneitrightai
exists to eliminate.

## The players

| | OpenClaw | Hermes Agent | NanoClaw |
|---|---|---|---|
| Repo | [openclaw/openclaw](https://github.com/openclaw/openclaw) | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) |
| Stars / open issues | 377.8k / 7,982 | 188.5k / 19,928 | 29.8k / 743 |
| Size | ~500k LOC, 53 config files, 70+ deps | Large Python codebase, multi-backend | ~15 source files, single process |
| Built on | Own runtime + 20+ channel gateway | Own loop, model-agnostic (OpenRouter etc.) | Claude Agent SDK + per-group containers |
| License | MIT (license text now nonstandard) | MIT | MIT |

History worth knowing: OpenClaw is Peter Steinberger's project (Clawdbot →
Moltbot → OpenClaw after Anthropic trademark complaints); he joined OpenAI in
Feb 2026 and the project moved to an OpenAI-backed foundation
([TechCrunch](https://techcrunch.com/2026/02/15/openclaw-creator-peter-steinberger-joins-openai/)).
NanoClaw was created in late Jan 2026 explicitly as a reaction to OpenClaw's
bloat and security record.

## 1. Context loss — the defining failure

**Compaction silently destroys instructions and work.** This is not an edge
case; it is the causal root of the worst incidents in the space.

- OpenClaw users lost days of agent work to silent compaction with no warning
  or recovery: [#5429](https://github.com/openclaw/openclaw/issues/5429),
  [#57410](https://github.com/openclaw/openclaw/issues/57410) (compaction =
  full context reset), [#15720](https://github.com/openclaw/openclaw/issues/15720)
  (sessions stuck at 100% context, can't compact at all),
  [#60719](https://github.com/openclaw/openclaw/issues/60719) (heartbeat
  sessions never compact — "weeks of heartbeat cycles → zero memory
  persistence").
- The marquee incident: Meta AI safety director Summer Yue's agent **deleted
  200+ emails** after compaction dropped her "don't action until I tell you"
  instruction — and "STOP OPENCLAW" didn't stop it
  ([Dataconomy](https://dataconomy.com/2026/02/24/meta-head-summer-yue-loses-200-emails-to-rogue-openclaw-agent/),
  [Galileo analysis](https://galileo.ai/blog/openclaw-sobering-lessons-from-an-agent-gone-rogue)).
- Hermes markets "persistent memory" but its compaction demotes memory to
  "background reference, NOT active instructions" — the agent then ignores its
  own memory after restart
  ([#17251](https://github.com/NousResearch/hermes-agent/issues/17251)). A
  production field report measured **~2.6M tokens (~69% of a 12-hour
  session's spend) burned on session-replay overhead**, plus state.db
  corruption ([#5563](https://github.com/NousResearch/hermes-agent/issues/5563)).
  In [#20849](https://github.com/NousResearch/hermes-agent/issues/20849) the
  agent trusted a stale `session_search` summary over an explicit handoff file
  and **overwrote days of progress**.

**Memory that grows worse with use.** OpenClaw's memory is flat markdown +
grep/vector retrieval: "the more you use OpenClaw, the worse its memory gets —
it remembers everything but understands none of it"
([Daily Dose of DS](https://blog.dailydoseofds.com/p/openclaws-memory-is-broken-heres),
[HN](https://news.ycombinator.com/item?id=47721955),
[#43747 "Memory management is in chaos"](https://github.com/openclaw/openclaw/issues/43747)).
The cottage industry of third-party fixes (memsearch, Cognee, LosslessClaw,
mem0 guides) is itself proof of the gap.

## 2. File clutter / workspace rot

- OpenClaw's workspace is a pile of bootstrap markdown (AGENTS.md, SOUL.md,
  TOOLS.md, USER.md, MEMORY.md, daily `memory/YYYY-MM-DD.md` notes) that
  accumulates redundancy and contradictions; stale content silently degrades
  the agent and wastes tokens every turn. There are hard truncation caps
  (20k chars/file, 150k aggregate) that clip whatever overflows
  ([VelvetShark](https://velvetshark.com/openclaw-memory-masterclass)).
- Dedicated cleanup tools exist because workspaces rot:
  [win4r/openclaw-workspace](https://github.com/win4r/openclaw-workspace)
  (workspace maintenance skill),
  [silicondawn/memory-viewer](https://github.com/silicondawn/memory-viewer).
  Nobody ships hygiene as a built-in.
- Hermes: agent-authored SKILL.md files pile up in `~/.hermes/skills/` —
  doubling as a persistent prompt-injection vector (see §4).

## 3. Operational complexity

- OpenClaw: ~500k LOC, 53 config files, 70+ dependencies; strict-schema
  gateway config that refuses to start on any unknown key; 24+ channels, node
  pairing, and skill management each add config surface. Hugo Dutka's
  ["How to build OpenClaw in 400 lines"](https://hugodutka.com/posts/openclaw-400-loc/)
  is the canonical argument that most of this is accidental complexity.
- Hermes: praised one-line install, but ~20k open issues, a
  Docker/SSH/Modal/Daytona/Termux backend matrix, and context-window
  auto-detection bugs generate constant config churn.
- NanoClaw is the anti-complexity proof point (no config files — you edit the
  code; channels installed on demand). Its real gaps: no skill discovery,
  Claude-only, weak network-egress controls, macOS container path confusion
  ([VirtusLab review](https://virtuslab.com/blog/ai/nano-claw-your-personal-ai-butler)).

## 4. Security

OpenClaw's Feb–Apr 2026 crisis is the defining agent-security event of the
year:

- **~135,000 internet-exposed instances** across 82 countries, 63% with
  gateway auth disabled — root cause: default bind to `0.0.0.0:18789`. Open
  instances leaked Anthropic API keys, Telegram bot tokens, Slack OAuth creds,
  full chat histories
  ([The Signal Cage](https://signalcage.com/artificial-intelligence/2026/17/20/openclaw-security-crisis-135000-exposed-instances-and-active-infostealer-campaigns-february-2026/)).
  (Exact counts are contested — 63k–220k across rescans — the order of
  magnitude is not.)
- **~137 CVE advisories in three months**, 7 critical, incl. CVE-2026-25253
  "ClawBleed" (one-click RCE from a malicious webpage, actively exploited) and
  CVE-2026-32922 (CVSS 9.9, paired device → full admin RCE).
- **"ClawHavoc" supply-chain attack**: ClawHub had no signing, review, or
  sandbox; researchers found 341 → ultimately **1,184 trojanized skills**
  (91% containing prompt injection, second stage: Atomic macOS Stealer). The
  #1 skill on the marketplace was malware
  ([The Hacker News](https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html),
  [Trend Micro](https://www.trendmicro.com/en_us/research/26/b/openclaw-skills-used-to-distribute-atomic-macos-stealer.html)).
- Fallout: Meta, Google, Microsoft, Amazon banned it for employees.
- Hermes is not clean: **CVE-2026-9366** — unauthenticated prompt-pipeline
  injection, public exploit, vendor unresponsive at disclosure
  ([SentinelOne](https://www.sentinelone.com/vulnerability-database/cve-2026-9366/));
  plus injection in its LLM-based auto-approval
  ([#21425](https://github.com/NousResearch/hermes-agent/issues/21425)) and a
  4-critical/9-high audit of the default config
  ([#7826](https://github.com/NousResearch/hermes-agent/issues/7826)).
- NanoClaw's container-per-group isolation largely holds; remaining critiques
  are network egress and audit logging
  ([Airia](https://airia.com/nanoclaw-ai-agent-security-risks-shadow-ai/)).

## 5. Reliability and cost blowups

- OpenClaw runaway loops with receipts: **$350 in 3.5 hours over 809
  consecutive tool calls** re-reading the same files; a weekend loop producing
  a **$1,200 Monday bill**; $47 overnight from a retry loop with no backoff
  ([BetterClaw](https://www.betterclaw.io/blog/openclaw-agent-stuck-in-loop),
  [Capodieci](https://capodieci.medium.com/ai-agents-035-your-openclaw-agent-can-burn-300-day-without-these-cost-guards-36848a8023c2)).
  No native budget limits — third-party "firewalls" fill the gap.
- Destructive actions chain directly off context loss (the Summer Yue inbox
  deletion is compaction → rogue action, end to end).

## What this means

Every category above is either **unsolved by the incumbents** or solved only
by bolt-ons that add the very complexity users hate. The opening is a system
where durable memory, workspace hygiene, secure defaults, and budget guards
are **built in and invisible** — not 53 config files and a marketplace of
patches. That is the product. See [PLAN.md](PLAN.md).
