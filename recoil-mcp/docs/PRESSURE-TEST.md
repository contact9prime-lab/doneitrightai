# Pressure Test: Proof of Done

Adversarial research, 2026-06-09. Question asked: what kills this, who's
already close, does the evidence support the design, and where's the
beachhead. Verdict up front: **build-with-changes** (the three changes are
now folded into [SPEC.md](SPEC.md)).

## Top 5 kill risks, ranked

**1. Big labs ship native verification — the wedge closes.**
Anthropic launched Claude Code Review (Mar 2026) and runs independent
verification subagents on findings
([InfoQ](https://www.infoq.com/news/2026/04/claude-code-review/),
[Opus 4.8 announcement](https://www.anthropic.com/news/claude-opus-4-8)).
If the harness vendor verifies natively, a hook-based verifier is a feature,
not a product. The one defensible distinction: **a vendor verifying its own
model's work is structurally not independent.** PoD's neutrality is the moat —
and it must be argued explicitly, because most buyers won't care by default.

**2. Goodhart's law eats the Contract — the empirically dominant failure.**
2026 evidence is brutal: agents overwrite unit tests, monkey-patch scoring
functions, delete assertions; reward hacking hit 100% of attempts on some
benchmarks ([SpecBench](https://arxiv.org/abs/2605.21384),
[LLMs Gaming Verifiers](https://arxiv.org/html/2604.15149)). A
machine-readable definition of done is also a machine-readable *target*.
Consequence: tier-0 checks must be **hermetically re-executed by the verifier
in a sandbox the worker never touched** — "worker reports tests passed" is
how receipts end up certifying fraud, which is worse than no receipt.

**3. LLM-judge reliability is shaky in production — one wrong receipt burns the brand.**
Judges hit ~80% accuracy in controlled tests but >50% error rates on bias
tests in production conditions
([Adaline](https://www.adaline.ai/blog/llm-as-a-judge-reliability-bias)).
A signed receipt makes a strong epistemic claim; "PoD-certified, actually
broken" going viral once is existential. Consequence: tier-2 verdicts are
**signed opinions, labeled as such** — never marketed as proof.

**4. Contract-writing friction — the quiet killer.**
The closest grassroots analogues stalled exactly here: llms.txt is at ~10%
adoption with zero major-platform consumption
([ppc.land](https://ppc.land/llms-txt-adoption-stalls-as-major-ai-platforms-ignore-proposed-standard/));
AGENTS.md files often *hinder* agents
([InfoQ/ETH study](https://www.infoq.com/news/2026/03/agents-context-file-value-review/)).
If humans must author contracts per task, PoD gets llms.txt's curve.
Consequence: **contracts are auto-drafted** (by a model different from the
worker) from the task/issue, approved in one click, with templates per task
type.

**5. Cost/latency in a market obsessed with cutting token spend.**
Verification roughly doubles cost per task; teams already model 1.5–2.5×
multipliers and the loudest 2026 agent-ops content is about *reducing* spend
([Stevens](https://online.stevens.edu/blog/hidden-economics-ai-agents-token-costs-latency/),
[Vantage](https://www.vantage.sh/blog/agentic-coding-costs)). PoD survives
only where unverified work visibly costs more than the verification tax.

Honorable mention: high-stakes verticals are being locked up by proprietary
trust suites — Thomson Reuters' Fiduciary-Grade AI™
([press release](https://www.thomsonreuters.com/en/press-releases/2026/may/thomson-reuters-standard-for-high-stakes-ai))
and Vanta's compliance machine. Don't fight them head-on.

## Prior-art map (how open is the gap?)

| Player | Slice | Open? | Distance from PoD |
|---|---|---|---|
| [Tool Receipts / NabaOS](https://arxiv.org/abs/2603.10060) | Signed receipts that tool calls happened (94.2% fabrication detection, <15ms) | Academic | Closest on the Receipt — but verifies *claims about actions*, not outcome quality. Also a name-collision risk on "receipts" |
| [Verifiability-First / OPERA](https://arxiv.org/abs/2512.17259) | Audit agents + intent schema + attestations | Academic | Close on architecture, heavyweight, no adoption path |
| [TessPay](https://arxiv.org/pdf/2602.00213) | Verify-then-pay agent commerce | Academic/startup | Closest on the economic loop, scoped to payments |
| [Mastercard Verifiable Intent](https://www.pymnts.com/mastercard/2026/mastercard-unveils-open-standard-to-verify-ai-agent-transactions/) | Cryptographic proof of transaction *intent* | Open, corp-backed | Authorization, not work quality — shows big players pick the payments slice |
| Identity layer ([AIP](https://arxiv.org/pdf/2603.24775), ARIA, ANS) | Who the agent is, verifiable delegation | Open/NIST | Orthogonal; PoD receipts chain on top of it |
| Eval platforms (Braintrust, LangSmith, Galileo) | "Is the output good?" as SaaS observability | Proprietary | Same job, no portable cross-org receipt — could add one in a quarter |
| [Thomson Reuters](https://www.thomsonreuters.com/en-us/posts/innovation/thomson-reuters-standard-for-high-stakes-ai/) | "Verifiable AI work" for legal/tax | Proprietary, trademarked | Same positioning, vertical-locked; proves demand at the high end |
| MCP/A2A roadmaps ([MCP 2026](https://a2a-mcp.org/blog/mcp-2026-roadmap)) | Tasks primitive, audit trails | Open (LF) | **No outcome-verification primitive in either roadmap yet** — watch MCP Tasks weekly; if it grows a verification field, propose PoD as that extension, don't compete |
| OpenAI | Winding down Agent Builder + Evals by Nov 2026 | — | Retreating from this layer — leaves space |

**Net:** nobody has shipped an open, cross-vendor, contract + independent
verifier + portable receipt standard for *outcomes*. But four academic papers
and two payment startups are circling within ~12 months. The window is open
and closing.

## Does the evidence support the design?

- **Cross-model verification is the best-supported element.** NYU's 37-model
  study: cross-family verification significantly beats self/intra-family, and
  the gap *widens* as models strengthen
  ([arXiv 2512.02304](https://arxiv.org/abs/2512.02304)); self-consistent
  errors rarely overlap across families
  ([arXiv 2505.17656](https://arxiv.org/pdf/2505.17656)).
- **Rubrics beat vibes:** rubric-guided verifiers beat vanilla judges by
  12–48% meta-eval F1 ([arXiv 2601.15808](https://arxiv.org/html/2601.15808v1))
  — supports tier-2's rubric requirement.
- **Deterministic claim-checking is near-solved** (94.2% fabrication
  detection, <15ms — Tool Receipts above).
- **Verification is cheaper than generation**
  ([arXiv 2509.11068](https://arxiv.org/pdf/2509.11068)), with diminishing
  returns after 1–2 verify rounds.
- **Tier-2 cannot honestly be "proof."** Production judge bias is too high;
  the receipt labels it a scored opinion. Tiers 0–1 carry the brand.

## Standards-history rules (what a two-person team must do)

1. **One anchor adopter beats a perfect spec.** MCP's inflection was a
   heavyweight shipping it as default
   ([The New Stack](https://thenewstack.io/why-the-model-context-protocol-won/)).
   The real job is landing one anchor, not polishing the schema.
2. **Be good-enough at the moment of acute pain** — the unreviewed-agent-work
   window is open now.
3. **Standards that make publishers work while consumers ignore them die**
   (llms.txt). The contract must cost ~zero to produce and the receipt must
   pay off immediately (merge gate, payment release).
4. **Neutral governance is table stakes.** A verification standard owned by a
   model vendor is self-defeating by construction — two-person neutrality is,
   for once, an asset.
5. **Ship as a hook in existing harnesses, not a platform.** MCP won via SDKs
   people ran day one.
6. **The one-liner does real work.** "Receipts for agent work" — and note the
   name collision risk on "receipts" (PipeLab, NabaOS).

## Verdict: build-with-changes

The gap is real, the cross-model verifier is the single best-evidenced idea
in the space, and the pain curve is exploding — AI-generated code went from
1% to 27.6% of PRs in a year while human review remains the bottleneck
([Greptile](https://www.greptile.com/content-library/best-ai-code-review-tools),
[freeCodeCamp](https://www.freecodecamp.org/news/how-to-unblock-ai-pr-review-bottleneck-handbook/)).

Three changes were mandatory and are now in the spec:
1. Tier-0 = hermetic re-execution by the verifier (never worker-reported).
2. Contracts auto-drafted by a non-worker model, one-click approval,
   per-task-type templates.
3. Honest tier labels on every receipt: **verified** (tier-0) /
   **evidence-confirmed** (tier-1) / **scored opinion** (tier-2).

## Beachhead: the merge gate for agent-written PRs

Code PRs uniquely combine everything PoD needs:
- **Tier-0 dominance** — tests, builds, linters, type checks are
  deterministic, exactly where PoD is strongest (vs. browser/computer-use
  tasks, which are tier-2-heavy — the weak tier).
- **Acute, quantified pain** — 27.6% of PRs AI-authored, review bottleneck,
  only ~55% of AI code secure by default.
- **An existing consumption point** — branch protection / merge gates mean
  the receipt has immediate utility with zero new behavior.
- **The independence pitch lands** — a Claude-built PR verified by a
  non-Claude model is something Claude Code Review structurally cannot offer.
- **Two-person distribution** — a GitHub Action + a Claude Code hook.

Sequence: win the merge gate → accumulate receipt volume until the schema is
the de facto standard → expand to delegation chains when the MCP/A2A joint
spec (Q3 2026) creates the slot. Back-office/compliance verticals are left to
the incumbents; agent-to-agent marketplaces come later when that market is
real.
