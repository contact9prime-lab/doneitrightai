# Recoil MCP

**The undo layer for AI agents. It audits and recoils MCP work.**

Every layer of the agent stack — models, MCP, skills, harnesses — was built
for the *worker*. Nothing was built for the *principal*: the human handing
over power. When you hire a person, civilization gives you approval chains,
audits, and the ability to reverse a bad decision. When you "hire" an agent,
you get a yes/no permission prompt — and in May 2026 a frontier agent wiped
a production database and three months of backups in nine seconds.

Recoil is that missing layer, as one small MCP proxy:

> **Nothing an agent does is real until it's committed,
> and everything it did can be recoiled for a window.**

## How it works

Recoil speaks MCP on both sides — server to your agent, client to your real
MCP servers — so **every existing agent and tool works unchanged**. Every
call is classified into three tiers:

- **pass** — reads are forwarded instantly and audited in an append-only
  ledger.
- **undoable** — writes are snapshotted first, then forwarded; `recoil undo`
  restores the pre-action state any time within the commit window.
- **hold** — deletes, sends, payments, deploys are **not executed**. They
  wait, staged, until a human runs `recoil commit <id>`. The agent cannot
  approve its own actions, and identical retries dedupe instead of stacking.

If Recoil can't promise recovery (snapshot too large, nothing to snapshot),
it escalates to a hold instead of pretending — honesty over convenience.

## Quick start

```bash
npm install && npm run build

# recoil.config.json — wrap your real servers:
{
  "servers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"] }
  }
}

# point your agent (Claude Code, NanoClaw, any MCP host) at:
node dist/index.js recoil.config.json

# the human side:
recoil ledger          # audit trail of everything the agent did
recoil commit <id>     # approve a held action
recoil undo <id>       # recoil an applied action / discard a held one
```

Generality comes from the tier design — audit and hold need zero domain
knowledge, so *any* MCP server is protected the moment it sits behind
Recoil — plus **server profiles**, curated rule packs for popular servers
(`github`, `supabase`, `postgres`, `slack`, `gmail`):

```json
"gh": { "command": "...", "profile": "github" }
```

See it live:

```bash
node examples/demo.mjs        # write → recoil; destructive move → held → human commit
node examples/demo-multi.mjs  # filesystem + memory server behind one ledger
```

## Docs

- [`docs/RECOIL.md`](docs/RECOIL.md) — design: the three verbs, three tiers,
  ledger semantics, undo adapters, stated limits
- [`docs/SPEC.md`](docs/SPEC.md) — Proof of Done: the verification
  counterpart (receipts as commit criteria — the other half of the
  delegation layer)
- [`docs/PROBLEMS.md`](docs/PROBLEMS.md) /
  [`docs/PRESSURE-TEST.md`](docs/PRESSURE-TEST.md) /
  [`docs/PLAN.md`](docs/PLAN.md) — the research trail that led here:
  failure catalogue of today's agents, adversarial market analysis, and the
  reference-assistant plan

## Status

v0.1 — working proxy with filesystem undo adapter, hold/commit/recoil
lifecycle, JSONL audit ledger, human-side CLI. 8 unit tests plus an
end-to-end demo against the official filesystem MCP server. Next: email
(delay-send) and git adapters, receipt-gated commits.
