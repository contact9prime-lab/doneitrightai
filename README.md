# Recoil MCP

**The undo layer for AI agents. It audits and recoils MCP work.**

> Nothing an agent does is real until it's committed,
> and everything it did can be recoiled for a window.

Recoil is a small MCP proxy that sits between any agent and its tools. Every
tool call is audited in an append-only ledger; writes are snapshotted and
undoable; destructive actions — deletes, sends, payments, deploys, raw SQL —
are **held** and never execute until a human approves them. The agent cannot
approve its own actions.

Why this layer exists: smarter models don't make errors impossible, they make
them rarer and *bigger* — in May 2026 a frontier agent wiped a production
database and three months of backups in nine seconds. The labs make errors
rare. Recoil makes them cheap.

---

## Features

- **Universal coverage** — speaks MCP on both sides, so every existing agent
  (Claude Code, Claude Desktop, NanoClaw, any MCP host) and every existing
  MCP server works unchanged. Wrap one server or ten behind one ledger.
- **Three-tier policy** — every call is classified:
  | Tier | Behavior |
  |---|---|
  | `pass` | Reads forward instantly, audited. |
  | `undoable` | Snapshot first, then execute; `recoil undo` restores the pre-action state within the commit window (default 30 min). |
  | `hold` | **Not executed.** Staged until a human runs `recoil commit <id>`, or discarded. |
- **Server profiles** — curated rule packs for popular servers: `github`,
  `supabase`, `postgres`, `slack`, `gmail`. One word in the config; merging
  PRs, posting messages, and inserting rows are held while reads pass.
- **Built-in safety net** — even with no rules and no profile, destructive
  verbs (`delete*`, `drop*`, `send*`, `pay*`, `deploy*`, `merge*`,
  `execute*`, `apply*`, …) are held everywhere.
- **Append-only audit ledger** — every action and status transition is an
  event in `.recoil/ledger.jsonl`. Greppable, diffable, no database.
- **Filesystem undo adapter** — path arguments are snapshotted before the
  call; overwrites revert, created files are removed on recoil.
- **Honesty guarantees** —
  - the agent cannot commit its own held actions (`allowAgentCommit: false`
    by default); approval arrives from the human CLI;
  - if a snapshot would exceed `maxSnapshotBytes`, the action escalates to a
    hold rather than executing unrecoverably;
  - identical retries of a held call dedupe to the same action id instead of
    stacking.
- **Human console** — `recoil ledger` / `recoil commit <id>` /
  `recoil undo <id>` from any terminal, no daemon required (file-based IPC
  the proxy polls every second).

## How it works

```
                     ┌──────────────────────── Recoil ────────────────────────┐
  agent (any MCP     │  policy: rules → profile → built-ins → default         │   your real
  host) ────────────▶│  pass ──────────────────────────────▶ forward          │──▶ MCP servers
                     │  undoable ──▶ snapshot ─────────────▶ forward          │   (fs, github,
                     │  hold ──▶ ledger (staged) ⏸  …human commit… ▶ forward  │   db, slack…)
                     │                                                        │
                     │  ledger.jsonl  ◀── every action, every transition      │
                     └────────────────────────────────────────────────────────┘
                            ▲                                      │
                            └── recoil ledger / commit / undo ─────┘  (human CLI)
```

## Quick start

```bash
git clone https://github.com/contact9prime-lab/doneitrightai && cd doneitrightai
npm install && npm run build && npm link    # `npm link` puts `recoil` on your PATH
```

Create `recoil.config.json` (see `recoil.config.example.json`):

```json
{
  "servers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"] },
    "gh": {
      "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." },
      "profile": "github"
    }
  }
}
```

See it live before wiring anything:

```bash
node examples/demo.mjs        # write → recoil; destructive move → held → human commit
node examples/demo-multi.mjs  # filesystem + memory server behind one ledger
```

## Connect your agent

Point the host at Recoil **instead of** at the wrapped servers (don't list
them twice, or the agent gets an unguarded path).

**Claude Code** — `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "recoil": {
      "command": "node",
      "args": ["/path/to/doneitrightai/dist/index.js", "/path/to/recoil.config.json"]
    }
  }
}
```

**Claude Desktop** — same block under `mcpServers` in
`claude_desktop_config.json`.

**NanoClaw / any MCP host** — anything that can spawn a stdio MCP server can
spawn Recoil; it exposes all downstream tools (name-collision-safe) plus
three control tools: `recoil_ledger`, `recoil_undo`, `recoil_commit`.

## The human console

```bash
recoil ledger          # audit trail, newest first; held actions are flagged
recoil commit a1b2c3d4 # approve a held action — only now does it execute
recoil undo a1b2c3d4   # recoil an applied action / discard a held one
```

```
$ recoil ledger
3f9a12c4  2026-06-09T19:20:11Z  applied   fs/write_file
ecdacb48  2026-06-09T19:20:12Z  held      gh/merge_pull_request  <-- awaiting `recoil commit ecdacb48`
```

The CLI reads/writes the data dir directly — set `RECOIL_DATA_DIR` if it
isn't `./.recoil`.

## Configuration reference

| Field | Default | Meaning |
|---|---|---|
| `servers` | — | Downstream MCP servers: `command`, `args`, `env`, optional `profile`. |
| `servers.<name>.profile` | none | Built-in rule pack: `github`, `supabase`, `postgres`, `slack`, `gmail`. |
| `rules` | `[]` | Your policy: `{ "match": "glob\|glob", "server": "optional", "tier": "pass\|undoable\|hold" }`. First match wins. |
| `defaultTier` | `undoable` | Tier for tools nothing matches. |
| `commitWindowMs` | `1800000` | How long applied actions stay recoilable before finalizing. |
| `allowAgentCommit` | `false` | Whether the agent may approve its own held actions. Leave this off. |
| `maxSnapshotBytes` | `52428800` | Snapshot budget; larger work escalates to hold. |
| `dataDir` | `.recoil` | Ledger, snapshots, and command queue location. |

Precedence: **your rules → server profile → built-in safety net →
`defaultTier`.** A hold too strict for your workflow is one `pass`/`undoable`
rule away — loosen deliberately, per tool, not globally.

**Action lifecycle:** `passed` · `applied` → (`recoiled` | `final`) · `held` →
(`committed` | `discarded`) · `failed`.

## Deploy

**Local (recommended today).** Recoil is a stdio MCP server: the host spawns
it, it spawns your downstream servers. There is nothing else to run — the
ledger is a file, the CLI reads it directly. Survives reboots by design;
state is just the data dir. Backup = copy the data dir.

**Docker.** A two-stage `Dockerfile` ships in the repo:

```bash
docker build -t recoil-mcp .
mkdir -p ~/recoil-data && cp recoil.config.json ~/recoil-data/   # set "dataDir": "/data/.recoil"
```

Then have the MCP host spawn the container:

```json
{
  "mcpServers": {
    "recoil": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "/home/you/recoil-data:/data", "recoil-mcp"]
    }
  }
}
```

The shared volume is the deployment trick: the **ledger, snapshots, and
command queue live on the host**, so `RECOIL_DATA_DIR=~/recoil-data/.recoil
recoil ledger` and `recoil commit <id>` work from the host terminal while the
proxy runs containerized. Downstream servers launched via `npx` run inside
the container (network needed on first run — or bake them into a derived
image). Mount workspace paths the filesystem adapter should protect.

**Remote / hosted.** Today Recoil is stdio-only, which means it runs where
your agent host runs. A Streamable HTTP transport (one Recoil service guarding
a team's servers, with auth) is the next deployment milestone — see Roadmap.

## Guarantees and limits, stated plainly

- Recoil reverses *local, adapted* effects and **prevents** irreversible
  ones. It cannot un-send what a downstream tool already sent — which is
  exactly why outbound verbs are held rather than trusted.
- Path extraction is heuristic (absolute paths under path-shaped argument
  keys). A tool with exotic argument names may execute with nothing
  snapshotable — the ledger records that honestly. Add a `hold` rule for
  such tools.
- The commit window is a promise window: after it elapses, actions finalize
  and snapshots are no longer guaranteed.
- Recoil protects against agent mistakes and runaway loops, not against a
  malicious local user. It trusts its host.

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest: policy, ledger, snapshots, full lifecycle (10 tests)
node examples/demo.mjs
node examples/demo-multi.mjs
```

Source is ~700 lines across 8 files (`src/`): `config` → `policy`/`profiles`
→ `core` (routing, hold/commit/recoil) → `ledger` → `snapshot` → `index`
(stdio server) / `cli` (human console).

## The research trail

This repo started as research into why agentic AI goes wrong and what layer
is missing. The conclusion — every layer of the stack serves the *worker*,
none serves the *principal* — is Recoil's reason to exist. The receipts:

- [`docs/RECOIL.md`](docs/RECOIL.md) — design: verbs, tiers, ledger
  semantics, adapters, limits
- [`docs/PROBLEMS.md`](docs/PROBLEMS.md) — sourced failure catalogue of
  OpenClaw, Hermes, NanoClaw (context loss, file clutter, the 2026 security
  crisis, cost blowups)
- [`docs/PRESSURE-TEST.md`](docs/PRESSURE-TEST.md) — adversarial market
  analysis: kill risks, prior art, LLM-as-judge evidence
- [`docs/SPEC.md`](docs/SPEC.md) — Proof of Done: the verification
  counterpart (receipts as commit criteria)
- [`docs/PLAN.md`](docs/PLAN.md) — the reference-assistant plan this grew
  out of

## Roadmap

1. **Email adapter** — delay-send: "the agent sent 200 emails — and they're
   all still in the outbox."
2. **Git adapter** — auto-stash/branch before agent edits; recoil = reset.
3. **Streamable HTTP transport** — one hosted Recoil guarding a team's
   servers, with auth and a web ledger view.
4. **Receipt-gated commits** — Proof of Done verification runs while an
   action is staged; the receipt becomes the commit criterion.
5. **Database adapter** — savepoint/transaction wrapping for SQL servers.

## License

MIT
