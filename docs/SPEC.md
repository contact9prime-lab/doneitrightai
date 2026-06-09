# Proof of Done — v0.1 (draft)

**An open standard for verifying that AI agent work was actually done right.**

MCP standardized how agents act. Skills standardized what they know. Nothing
standardizes how anyone — human or agent — knows the work met the goal.
Proof of Done (PoD) fills that hole with three small artifacts: a **Contract**,
a **Verifier**, and a **Receipt**.

Design principles: simple enough to read in five minutes; evidence over
narrative; falsify first; honest uncertainty; receipts are plain files that
travel with the work.

---

## 1. The Contract

Before work starts, the task gets a definition of done: the checks that would
prove success. A contract is a small YAML file (or front-matter block) the
requester writes — or the worker proposes and the requester approves.

```yaml
pod: "0.1"
task: "Reconcile May invoices and email the summary to finance"
checks:
  - id: totals-match
    tier: 0
    run: "python reconcile.py --verify --month 2026-05"   # exit 0 = pass
  - id: summary-sent
    tier: 1
    fact: "An email containing the May summary was sent to finance@acme.com"
  - id: nothing-deleted
    tier: 1
    fact: "No invoice or email was deleted during the task"
  - id: summary-quality
    tier: 2
    rubric: "Summary states total, count, and every unmatched invoice. No figure contradicts the source data."
    threshold: 0.8
invariants:
  - "No file outside the task workspace was modified"
  - "No message was sent to any recipient other than finance@acme.com"
```

**Check tiers** (the load-bearing idea — not all verification is equal, and
the receipt must never blur the difference):

| Tier | Kind | How it's decided | Trust level |
|---|---|---|---|
| **0** | `run` | Code executes; exit code decides. Tests, diffs, schema checks, linters. | Provable |
| **1** | `fact` | Verifier independently confirms the claim from evidence (files, APIs, logs) — never from the worker's say-so. | Confirmed |
| **2** | `rubric` | Verifier scores 0–1 against the rubric, with stated confidence. | Judgment |

**Invariants** are facts that must remain true throughout the task (the
"don't delete my emails" clause). They are tier-1 checks evaluated against
the action log / workspace diff, and they exist because the worst documented
agent incidents were invariant violations, not missed goals.

## 2. The Verifier

Any agent or program may verify, subject to five rules:

1. **Independence.** Fresh context. The verifier never sees the worker's
   reasoning or transcript — only the contract, the work product, and the
   evidence. (A verifier that reads the worker's story inherits the worker's
   delusions.)
2. **Different model where possible.** Same-model self-preference is a known
   bias; the receipt records worker and verifier models so consumers can
   judge.
3. **Falsify first.** The verifier's stance is "prove this was NOT done."
   It runs tier-0 checks as code, hunts for independent evidence on tier-1,
   and scores tier-2 against the rubric only.
4. **Every check gets a verdict:** `pass`, `fail`, or `unverifiable`. Silent
   skips are forbidden — `unverifiable` is an honest first-class answer.
5. **No repair.** The verifier never fixes the work. Verification and
   generation stay separated, or the verifier becomes a worker grading
   itself.

## 3. The Receipt

A signed JSON file, written next to the work, chained across delegations:

```json
{
  "pod": "0.1",
  "task": "Reconcile May invoices and email the summary to finance",
  "contract": "sha256:9f2c…",
  "worker":   { "agent": "doneitright/0.1", "model": "claude-opus-4-8" },
  "verifier": { "agent": "pod-verify/0.1",  "model": "gpt-5.2" },
  "checks": [
    { "id": "totals-match",    "tier": 0, "verdict": "pass", "evidence": "sha256:ab12…" },
    { "id": "summary-sent",    "tier": 1, "verdict": "pass", "evidence": "sha256:cd34…" },
    { "id": "nothing-deleted", "tier": 1, "verdict": "pass", "evidence": "sha256:ef56…" },
    { "id": "summary-quality", "tier": 2, "verdict": "pass", "score": 0.92, "confidence": 0.85 }
  ],
  "invariants": "pass",
  "verdict": "done",
  "evidence_bundle": "sha256:7a9b…",
  "parent_receipt": null,
  "timestamp": "2026-06-09T18:40:00Z",
  "signature": "ed25519:…"
}
```

**Verdict rules** (mechanical, no discretion):
- `done` — every tier-0 and tier-1 check and every invariant passes; every
  tier-2 score ≥ its threshold.
- `not-done` — any check or invariant fails. Failures are listed; the receipt
  is still issued (a failure receipt is as valuable as a success receipt).
- `partial` — no failures, but one or more checks `unverifiable`; they are
  listed so the consumer knows exactly what was not proven.

**Chaining.** When agent A delegates to agent B, B's receipt records A's
contract hash as `parent_receipt` context, and A's own receipt links B's.
Proof travels with the work, all the way up.

**Evidence bundle.** Hashes of the artifacts the verdicts rest on (command
output, diffs, queried records), stored alongside the receipt so any verdict
can be re-audited later.

## 4. Integration

PoD is a hook, not a platform. Any harness adopts it in one step:

- **Claude Code / Agent SDK:** a `Stop`/`SessionEnd` hook runs
  `pod verify <contract> <workspace>` and writes the receipt to `receipts/`.
- **NanoClaw / OpenClaw-style assistants:** the verifier runs in a sibling
  container; the receipt is posted back to the channel as the completion
  message — "Done ✅ (receipt)" replaces "Done!".
- **CI:** a job verifies agent-authored PRs and attaches the receipt to the PR.

A task without a contract gets a **default contract**: invariants only
(workspace containment, no destructive actions outside scope) — so even
unconfigured tasks produce a minimal receipt. Zero-config still yields proof.

## 5. What PoD is not

- Not an eval framework (evals measure models offline; PoD attests live work).
- Not identity or provenance (those say *who* and *from where*; PoD says
  *whether it met the goal* — it composes with them).
- Not a guarantee. Tier-2 verdicts are judgments and labeled as such. PoD's
  promise is honesty about what was proven, confirmed, and judged — never
  certainty it doesn't have.

---

*Status: draft for discussion. Reference implementation: this repo.*
