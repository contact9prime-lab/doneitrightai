# Build Plan

Decision record + architecture + roadmap. Companion to
[PROBLEMS.md](PROBLEMS.md). Drafted 2026-06-09.

## Guiding principle

**Simplicity is the product.** Every feature ships as a default behavior, not
a config option. If a capability needs a manual, it isn't done. The moat is
not channels or skills (commoditized); it is that this engine *never loses the
plot, never makes a mess, and never needs babysitting* — properties that are
hard to retrofit onto a 500k-LOC codebase, which is exactly why they're hard
to replicate.

## Fork decision: NanoClaw, on the Claude Agent SDK

| Candidate | Verdict | Why |
|---|---|---|
| **NanoClaw** (MIT) | **Fork this** | ~15 files / single process, container-per-group isolation, SQLite-only IPC, designed to be forked (installation files stay local, trunk rebases cleanly). Small enough to truly own. |
| OpenClaw (MIT) | Mine for ideas only | ~500k LOC, ~58k commits, 433 patched CVEs, ClawHavoc supply chain. Forking means inheriting the bloat and the attack surface while losing upstream velocity. Steal its memory-file conventions and channel UX, nothing else. |
| Claude Agent SDK | Keep as engine layer | Gives sessions+resume, compaction, subagents, hooks (PreToolUse/PostToolUse/SessionStart/End), MCP, permissions for free. NanoClaw already sits on it. |
| pi (badlogic, MIT) | Escape hatch | Multi-provider minimal harness, but a *coding* agent — no channels, scheduler, or memory. Its `pi-ai` unified LLM layer is our documented hedge against Anthropic lock-in. |
| Letta/MemGPT (Apache-2.0) | Reference architecture | Best memory ideas (self-editing blocks, sleep-time consolidation), but adopting its runtime contradicts operational simplicity. Their own benchmark shows file-based memory is competitive. |

### Compliance guardrails (non-negotiable)

- **API-key auth only** (or Bedrock/Vertex/Azure). Anthropic prohibits
  claude.ai OAuth / subscription tokens in products built on the Agent SDK
  (this is also NanoClaw's open issue #1224). Commercial use under Anthropic's
  Commercial ToS is explicitly permitted with API keys.
- No "Claude Code" naming or visual identity; "Powered by Claude" is fine.
- Keep the SDK behind one thin internal interface so the pi-ai escape hatch
  stays real.

## What we build on top (the three differentiators)

### 1. Memory that doesn't degrade ("never loses the plot")

File-first, hybrid of the three *proven* patterns — explicitly not a vector
database, which for personal-agent scale loses on debuggability and silently
degrades (vectors become an optional index only past thousands of entries):

- **Substrate:** SDK compaction + Anthropic's memory tool (measured: 84% token
  reduction on 100-turn tasks, +39% performance combined).
- **Durable layer (OpenClaw's good idea, done right):** curated `MEMORY.md` +
  daily notes, plus a background **consolidation pass** ("dreaming") that
  promotes, dedupes, and *deletes contradictions* — the step OpenClaw never
  shipped, which is why its memory rots.
- **Recall layer (claude-mem's good idea):** PostToolUse hooks compress
  observations into per-group SQLite with full-text search.
- **The fix for the killer bug:** a **pinned-instructions register**. Standing
  orders ("don't action until I say so") live outside the compactable context
  and are re-injected after every compaction and restart. Compaction must
  never be able to drop a standing instruction — this single property would
  have prevented the worst documented incident in the space (the deleted-inbox
  case) and Hermes's memory-demotion bug (#17251).
- Everything greppable and user-auditable. No hidden state.

### 2. Workspace hygiene ("never makes a mess")

Nobody owns this niche. Enforced by hooks, invisible to the operator:

- **Filing rules:** every artifact the agent writes lands in a convention
  (`artifacts/`, `notes/`, `scratch/`) via PostToolUse hooks — no markdown
  confetti at the workspace root.
- **Scratch TTL:** `scratch/` is swept on a schedule; anything worth keeping
  must be filed or promoted to memory.
- **Janitor pass:** the same background cycle that consolidates memory also
  lints the workspace — stale files flagged, duplicates merged,
  contradictions between memory files surfaced instead of silently degrading
  the agent.
- **Invariant:** week-50 workspace ≈ day-1 workspace.

### 3. Operational simplicity + safety ("never needs babysitting")

Keep NanoClaw's discipline, add the guards the incumbents lack:

- One process, no config files; setup is a conversation, not YAML.
- **Secure defaults:** loopback bind + auth on (the opposite of OpenClaw's
  `0.0.0.0` default that exposed 135k instances), container-per-group with a
  network-egress allowlist (NanoClaw's known gap).
- **Hard budget limits built in:** per-task and per-day token/dollar caps,
  loop detection (same-file re-reads, no-progress turns), retry backoff. A
  runaway agent halts itself; no third-party "firewall" needed.
- **Destructive-action gate:** bulk deletes/sends require confirmation, and a
  stop command that actually preempts the loop (OpenClaw's "STOP" famously
  didn't).
- **No open skill marketplace.** Skills are local files reviewed like code.
  ClawHavoc (1,184 trojanized skills) is the cautionary tale; we don't
  recreate the vector.

## Roadmap

- **Phase 0 — Fork and strip (1–2 weeks).** Fork NanoClaw, wire API-key auth,
  pick the two channels that matter first (WhatsApp + Telegram), delete the
  rest. Get one agent group running end to end in a container.
- **Phase 1 — Memory engine (the moat).** Pinned-instructions register →
  compaction-survival tests → consolidation/"dreaming" cycle → SQLite FTS
  recall. Ship with a brutal test: 100-turn session, compact 5×, restart 3×,
  standing instructions and task state must survive verbatim.
- **Phase 2 — Hygiene engine.** Filing hooks, scratch TTL, janitor pass.
  Metric: zero unfiled artifacts after a week of daily use.
- **Phase 3 — Guards.** Budgets, loop detection, destructive-action gate,
  egress allowlist. Then (and only then) more channels.

## Non-goals

- Not a coding agent (Claude Code, pi, and OpenHands own that).
- No skill marketplace, no plugin registry, no 20-channel matrix.
- No multi-model support at launch (one model done right beats a matrix of
  half-tested backends; pi-ai is the documented exit if needed).
