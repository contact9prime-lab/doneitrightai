# Recoil MCP — design

**The undo layer for AI agents.** Recoil is an MCP proxy: it speaks MCP to
the agent and MCP to your real servers, so every existing agent and every
existing tool works unchanged. Point the agent at Recoil instead of at the
servers, and from that moment every tool call is audited, every write is
recoverable, and every destructive action waits for a human.

Why this layer: smarter models don't make errors impossible — they make them
rarer and *bigger*, because we trust them with more (May 2026: a frontier
agent wiped a production database and three months of backups in 9 seconds).
Verification competes with model intelligence; reversibility doesn't. The
labs make errors rare. Recoil makes them cheap.

## The three verbs

| Verb | What it means |
|---|---|
| **stage** | A consequential call is recorded and *not forwarded*. The agent gets a structured notice with an action id and instructions to ask the human — and not to retry (identical retries dedupe to the same id). |
| **commit** | A human approves a staged action (`recoil commit <id>`); only then does it execute. Agents cannot commit their own holds unless `allowAgentCommit` is explicitly enabled. |
| **recoil** | Undo. An applied action's pre-state snapshot is restored; a staged action is discarded before it ever ran. |

## The three tiers

Every call is classified — first by your rules, then by built-in safety
rules, then the default:

| Tier | Behavior | Examples (built-in) |
|---|---|---|
| `pass` | Forward immediately; audit in the ledger. | `read*`, `list*`, `get*`, `search*`, `query*` … |
| `undoable` | Snapshot what the call touches, forward, recoilable for the commit window (default 30 min), then finalized. | unknown tools, `write*`, `edit*` (default tier) |
| `hold` | Do **not** forward. Stage until a human commits or discards. | `delete*`, `send*`, `pay*`, `deploy*`, `merge*`, `drop*`, `purge*` … |

### Server profiles — multi-use-case coverage without rule-writing

The generality model: **audit and hold need zero domain knowledge** (you can
always undo what never ran), so any MCP server is protected the moment it
sits behind Recoil. Only snapshot-undo is per-domain. Precision comes from
**profiles** — curated rule packs referenced per server:

```json
{
  "servers": {
    "gh":   { "command": "...", "profile": "github" },
    "db":   { "command": "...", "profile": "supabase" },
    "chat": { "command": "...", "profile": "slack" }
  }
}
```

Built-in profiles: `github`, `supabase`, `postgres`, `slack`, `gmail`.
Precedence: your rules → the server's profile → built-in safety net →
default tier. The stance encoded in every profile: anything that changes
state other people can see (a PR, a Slack message, a production row) is
held; reads pass; loosen with a user rule where a hold is too strict. The
built-in net also holds the database-wipe class (`execute*`, `apply*`)
even with no profile set.

Two honesty rules with teeth:

- **If Recoil can't promise recovery, it doesn't pretend.** An undoable
  action whose snapshot would exceed `maxSnapshotBytes` is escalated to a
  hold rather than executed unrecoverably.
- **The worker cannot approve itself.** `recoil_commit` from the agent is
  refused by default; commits arrive from the human CLI through the data
  dir (file-based IPC the proxy polls every second).

## The ledger

Append-only JSONL at `.recoil/ledger.jsonl` — the audit half of "audits and
recoils". Every action and every status transition is an event; state is
replay. Statuses: `passed`, `applied`, `held`, `committed`, `recoiled`,
`discarded`, `final` (window elapsed), `failed`. Greppable, diffable, no
database, no hidden state.

```
$ recoil ledger
3f9a12c4  2026-06-09T19:20:11Z  applied   fs/write_file
ecdacb48  2026-06-09T19:20:12Z  held      fs/move_file  <-- awaiting `recoil commit ecdacb48`
```

## Undo adapters

v0.1 ships the filesystem adapter: path-shaped arguments (absolute paths
under keys like `path`, `file`, `source`, `destination`) are snapshotted
before the call and restored on recoil — overwrites are reverted, created
files are removed. Calls that touch nothing snapshotable are still audited.

The adapter interface is deliberately the thin end of a wedge: email
(delay-send), git (auto-stash/branch), databases (transaction/savepoint),
HTTP APIs (compensating calls) are next. For anything without an adapter,
**hold is the universal fallback** — you can always undo what never ran.

## Limits, stated plainly

- Recoil reverses *local, adapted* effects. It cannot un-send what a
  downstream tool already sent — which is exactly why outbound verbs are
  held by default rather than snapshotted.
- Path extraction is heuristic; a tool with unconventional argument names
  may apply without a snapshot (the ledger records that nothing recoverable
  was captured). Add a `hold` rule for such tools.
- The recoil window is a promise window: after it elapses, actions are
  finalized and snapshots are no longer guaranteed.
- Recoil trusts its host: it protects against agent mistakes and runaway
  loops, not against a malicious local user.

## Relationship to Proof of Done ([SPEC.md](SPEC.md))

Recoil is the staging half of the delegation layer; Proof of Done is the
verification half. They compose: work executes staged, gets verified against
its contract *while staged*, and the receipt becomes the commit criterion —
verified-then-committed, recoilable even after. v0.1 ships them separately;
the integration point is a verifier that watches held actions and attaches
receipts to the ledger.
