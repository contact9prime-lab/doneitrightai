# doneitrightai

**The agentic AI engine that doesn't forget and doesn't make a mess.**

Personal agentic assistants exploded in 2026 — OpenClaw (377k stars), Hermes
(188k stars), NanoClaw (29k stars). Every one of them goofs up the same way:
they **lose context over time** (compaction silently destroys instructions and
days of work) and they **clutter the workspace** (piles of contradictory
markdown memory files the agent retrieves but can't reason over). The fixes
people bolt on make operating them even more complicated.

doneitrightai takes the opposite bet: the moat is not more channels or more
skills — it is **durable memory, an always-clean workspace, and radical
operational simplicity**. Things should just happen, magically, without the
operator babysitting config files.

## The three promises

1. **Never loses the plot.** Compaction never drops standing instructions or
   in-flight work. Memory is curated, consolidated in the background, and
   auditable — plain files you can read and grep, not a black box.
2. **Never makes a mess.** Every artifact the agent creates is filed
   automatically. Scratch space has a TTL. A janitor pass keeps memory and
   workspace contradiction-free. Week 50 looks as clean as day 1.
3. **Never needs a manual.** One process, a handful of files, no config
   sprawl. Secure by default (loopback bind, auth on, containers per agent
   group). Hard budget limits so a runaway loop can't produce a $1,200 bill.

## How it's built

Fork of **NanoClaw** (MIT, ~4k lines, container-per-group isolation, SQLite
IPC) running on the **Claude Agent SDK** (sessions, compaction, subagents,
hooks, MCP). We keep that base almost untouched and build the differentiators
on top. See the docs:

- [`docs/PROBLEMS.md`](docs/PROBLEMS.md) — the sourced failure catalogue of
  OpenClaw, Hermes, and NanoClaw (what we are fixing, with receipts)
- [`docs/PLAN.md`](docs/PLAN.md) — fork decision, architecture, compliance,
  and roadmap

## Status

Research and planning phase. The problem map and build plan are done; Phase 0
(fork and strip) is next.
