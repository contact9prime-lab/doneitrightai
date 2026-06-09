# doneitrightai

**Proof of Done — the missing trust layer of the agent stack.**

LLMs gave AI a brain. MCP gave it hands. Skills gave it know-how. Agents made
it a worker. Every layer of *capability* now exists — and every agent still
grades its own homework. The deleted inboxes, the overwritten work, the flood
of slop: all the same failure, an **unverified claim of completion**.

The human economy never delegates on trust alone — it runs on contracts,
inspections, audits, and receipts. The agent economy has none of that.
doneitrightai builds it:

> **MCP standardized how agents act.
> Proof of Done standardizes how the world knows they did it right.**

## The standard, in one breath

1. **Contract** — before work starts, the task gets a small, machine-readable
   definition of done (deterministic checks, facts to confirm, judgment
   rubrics, and invariants like *"nothing gets deleted"*).
2. **Verifier** — an independent, fresh-context agent (ideally a different
   model) that never sees the worker's reasoning and tries to *falsify*
   completion.
3. **Receipt** — a signed, portable attestation of what was asked, what was
   checked, and what was proven. Receipts chain across delegations, so proof
   travels with the work.

Read the full draft: [`docs/SPEC.md`](docs/SPEC.md) — five minutes, that's
the point.

## Repo map

- [`docs/SPEC.md`](docs/SPEC.md) — Proof of Done v0.1 draft (the product)
- [`docs/PROBLEMS.md`](docs/PROBLEMS.md) — the evidence base: sourced failure
  catalogue of OpenClaw, Hermes, and NanoClaw (every incident is an
  unverified-completion failure)
- [`docs/PRESSURE-TEST.md`](docs/PRESSURE-TEST.md) — adversarial research:
  kill risks, prior-art map, LLM-as-judge evidence, standards-history rules,
  verdict and beachhead
- [`docs/PLAN.md`](docs/PLAN.md) — the agent engine (durable memory, workspace
  hygiene, built-in guards), now scoped as the **reference implementation**:
  the first assistant that ships receipts, not "Done!"

## Status

Pressure-test verdict: **build-with-changes** (changes folded into the spec).
Beachhead: **the merge gate for agent-written PRs** — a GitHub Action +
harness hook that hermetically re-runs tier-0 checks and attaches a signed
receipt to the PR. Cross-model verification is the best-evidenced design
choice in the space; the window is open and closing (~12 months).
