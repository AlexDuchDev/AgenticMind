# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.14.0] — 2026-08-03

The **evidence** release: what an agent did stops being a log line and becomes a
durable, queryable record — and where a decision needs a human, the loop now
suspends on that record instead of hoping the process stays alive. Ships the
assurance evidence plane (`POST /hooks/audit`), the durable human-in-the-loop
engine (12-factor F7 / STANDARD Layer 5), the §4 skill compiler behind two
decorrelated gates, and the verify-judge decorrelation the §1 audit demanded.

Upgrading from 0.11.x: migrations `0009`–`0017` apply in one pass. `0009` drops
the `kg_*` graph tables and `0011` re-creates them with tenant-isolation RLS —
graph rows do NOT survive that round trip, so re-ingest if you had
`KNOWLEDGE_GRAPHRAG_ENABLED` on. Everything from `0012` up is additive. No new
required environment variables.

### Added

- **Assurance evidence plane + `POST /hooks/audit`.** Tool calls arrive over an
  authenticated ingestion endpoint (body size capped — an unbounded body was a
  memory-exhaustion vector) and land in `tool_audit_events` via the evidence
  collector, so "which tool touched what, under whose authority" is a query
  rather than a grep. Includes the **L3 judge-gated remediation ladder**,
  hardened against five adversarial-review findings before merge.
- **Durable human-in-the-loop engine (12-factor F7).** A HITL request is modeled
  as a tool call the agent emits, suspending the loop on the durable substrate:
  it survives both a long human wait and a killed process. Three tiers — the
  request engine, the internal resume worker with a remediation gate, and the L3
  producer that **auto-proposes** remediations from assurance drift for a human
  to **approve**. Un-dormanting the remediation path never means acting without
  a person.
- **§4 skill compiler — `kl_compile_skill` MCP tool.** Compiles a corpus slice
  into a SKILL.md behind gates that fail closed: **L1** structural, **L2**
  faithfulness (every directive entailed by its own cited snippet — the skill is
  a projection of the corpus, nothing invented), and a **completeness reviewer**
  as a second, decorrelated judge covering what faithfulness structurally cannot
  see: a critical "never do X" that *is* in the corpus and never reached the
  skill. `corpusSnapshotId` is a deterministic content hash, so a recompile is
  reproducible without a snapshot store.
- **Eval-science AIUC-1 controls** in the AAL control catalog (calibrated
  verification + ground-truth provenance, Standard v3.1 Part V), and a
  **retrieval-ranking evaluation** with Recall@k / MRR and a gate.

### Changed

- **The verify judges no longer share a model family with the generator.** Two
  same-family passes are one opinion twice; the §1 audit called this the
  knowledge engine's CRITICAL finding. Judges now run decorrelated and at a
  pinned temperature — a non-deterministic judge cannot be calibrated — and the
  path **fails loud** rather than silently co-signing when decorrelation is not
  actually configured.
- **AgenticGateway is documented as the paved-road chat endpoint** (budgets,
  measured routing, cache, evidence) when composing the AgenticProduct stack.
  Comments only: `CHAT_BASE_URL`/`CHAT_API_KEY` keep working exactly as before.
- AgenticSelfHealingCode removed from the documented ecosystem family.

### Fixed

- **Images are built on the tag push, not on the GitHub Release.** `release.yml`
  cuts the Release with `GITHUB_TOKEN`, and GitHub raises no workflow-triggering
  events for `GITHUB_TOKEN` actions — so `release: published` never reached
  `release-images.yml`. **v0.12.0 and v0.13.0 have no images in GHCR at all**,
  and `latest` sat on 0.11.0 for eight weeks. Earlier tags only built because a
  human happened to re-publish the release by hand minutes later. Keying on the
  tag push takes the token out of the causal chain. Self-hosters on `:latest`
  move from 0.11.0 straight to 0.14.0 — read the migration note above first.
- **The `no-unsafe-*` lint family is back on for production code**, with a test
  that fails if it is ever silently disabled again. That family is the net for
  an `any` — from a raw SQL row, parsed LLM JSON, or a cast — propagating into
  typed code, which is precisely the hole `strict` tsc leaves open by design.
- Defensive JSON parsing for non-OpenAI verify judges, and a wider output-leak
  window that was producing false refusals.
- Worktree-safe `commit-msg` hook.

## [0.13.0] — 2026-07-04

The **correction** release: v0.12.0's BREAKING GraphRAG removal was a
misdiagnosis (an OpenAI-strict extractor emptied the graph — a
misconfiguration, not a dead feature), so GraphRAG returns as **experimental**,
together with the fix for the footgun and a guard that keeps it from silently
looking dead again. Deployments that kept `KNOWLEDGE_GRAPHRAG_ENABLED` off are
unaffected; upgraders from ≤0.11 get the graph tables re-created (with
tenant-isolation RLS) by migration `0011`.

### Added

- **GraphRAG restored as experimental — corrects the v0.12.0 removal.** v0.12.0
  removed GraphRAG as "non-functional (0 graph neighbours)", but that was a
  **misdiagnosis**: the verification ran the extractor on the default OpenAI-strict
  chat model, whose strict structured-output rejects the extractor's *nullish*
  schema → zero entities → empty graph. On a nullish-tolerant extractor the graph
  populates and resolves (verified live: 12/12 materials → 82 entities / 121
  mentions / 74 relations, `neighbors()` + multi-hop). The deleted modules and
  wiring (graph schema, `graphrag`, `graphrag-extractor`, `graphrag-postgres`,
  `graph-store`, `qaplan`, ontology, `kl_graph_neighbors`) are restored verbatim;
  migration `0011` re-creates the `kg_*` tables **with tenant-isolation RLS** (the
  `0009` drop is kept as history, not reverted). Off by default; positioned
  experimental and agent-unproven (see `docs/knobs.md`).
- **`KNOWLEDGE_GRAPHRAG_EXTRACTOR_MODEL`** — routes the entity/relation extractor
  to a nullish-schema-tolerant model (e.g. a Gemini id). This is the actual fix for
  the empty-graph footgun that caused the wrong removal. Unset = default chat model
  (safe only if it is not OpenAI-strict).

### Changed

- **GraphRAG is now covered by the enabled-but-dead guard.** The `graphrag` layer
  joins the manifest with an answer-observable predicate (`graphContextRows > 0`),
  so `smokeCheckableLayers` fails when GraphRAG is enabled but the graph is empty —
  exactly the silent state that the v0.12.0 removal misread. The extractor also
  warns loudly when a non-empty document yields zero entities.

## [0.12.0] — 2026-06-13

The **anti-hallucination** release. The synthesis LLM is the one component that
can fabricate; this release rings it with a seven-layer deterministic defense
(A–G) — every shield is no-LLM and structural, so the safety gate never rests on
a fallible judge. A–F *detect* fabrication (numeric, quote, citation-attribution,
card-source, cache, drift) and escalate to `needs_review`; **G** turns that
detection into prevention with a single `blockOnNeedsReview` refusal switch. The
non-functional GraphRAG path — proven to return 0 graph neighbours on every query
— is removed (**BREAKING**). Each layer also gains a standardised way to prove it
fires and to localise failures. Still drop-in (DB + `OPENAI_KEY`); every new guard
is off or neutral by default.

### Added

- **`blockOnNeedsReview` answer-policy switch (anti-hallucination defense G).** A
  single `KNOWLEDGE_ANSWER_POLICY` field that **hard-refuses** any answer the engine
  flagged `needs_review` — the one switch over *all* deterministic hallucination
  signals (fabricated figure/quote, mis-attributed citation, cited-but-unentailed
  claim, stale-only sources). Turns the detection that A–F produce into prevention:
  the answer is replaced by a refusal and `policy: { action: "block", reasons }` is
  attached to the trace. Off by default (review-only behaviour unchanged). A
  zero-hallucination strict-posture example is documented in `docs/knobs.md`.
- **Quoted-text verbatim check (anti-hallucination defense F).** A deterministic,
  no-LLM Tier-A check (`ungroundedQuotes`): every substantial double-quoted phrase
  (≥3 words) the answer presents as a direct quotation must appear verbatim
  (whitespace/case-normalised) in a cited snippet, else the answer escalates to
  `needs_review`. A fabricated quotation is a distinct, high-trust-looking
  hallucination class that the numeric (B) and attribution (E) checks miss. Surfaced
  on the answer + wired into diagnose.
- **Citation-attribution check (anti-hallucination defense E).** A deterministic,
  no-LLM Tier-A check (`weaklyAttributedClaims`): a substantial cited claim (≥5
  salient content words) whose own snippet shares *zero* salient words is almost
  certainly mis-attributed — the citation marker points at an unrelated passage.
  Tier-A only checked the marker resolves; B checks numbers; this catches a
  fabricated *non-numeric* claim wearing a decorative/wrong citation. Escalates to
  `needs_review`, surfaced on the answer, wired into diagnose. Conservative
  (only a total miss on a substantial claim flags) so paraphrase doesn't false-fire.
- **Fleet health / drift monitor (anti-hallucination detection D).** `ask_telemetry`
  now persists each answer's `status` (migration 0010); `summarizeAskHealth` (pure,
  unit-tested) turns a window's per-status counts into rates + threshold concerns,
  and `scripts/health.ts` prints them and exits non-zero on a breach (cron/alert
  friendly). Catches systemic degradation — model swap, corpus drift, regression —
  that the per-answer guards can't see. `DATABASE_URL` only, no LLM.
- **Card-source grounding at ingest (anti-hallucination defense C).** A
  deterministic, no-LLM filter (`dropUngroundedCards`): an LLM-extracted card that
  asserts a numeric figure absent from the source text it was extracted from is
  dropped before storage — otherwise a fabricated/garbled number would be persisted
  as a card and later surface as a confident `card_synth` answer. Tabular (no-LLM)
  cards skip the filter; reuses the Tier-A numeric check, so no extra LLM call.
- **Numeric verbatim check (anti-hallucination defense B).** A deterministic,
  no-LLM Tier-A check (`ungroundedFigures`): every *substantial* numeric figure the
  answer asserts must appear in a cited snippet, else the answer escalates to
  `status = needs_review` and the figures are surfaced on the answer. Tier-A only
  checked citation *presence*, never the number itself, so a fabricated figure in a
  cited sentence slipped through — the highest-impact hallucination class. Catches
  it without relying on another (fallible) LLM judge. Conservative (commas
  normalised; lone single digits ignored) to avoid false flags. Wired into the
  diagnose classifier too.
- **Layer verification & diagnostics framework.** A standardised way to test each
  layer and localise failures, so it isn't re-invented per incident (see
  `docs/verification.md`):
  - `lib/eval/layers.ts` — one declarative manifest of every optional layer (knob,
    default, purpose, and a pure "did it fire?" predicate). Single source of truth.
  - `smokeCheckableLayers()` — the "enabled-but-dead" guard: every enabled layer
    must demonstrably fire. This is exactly the regression the cache (0% hit) and
    GraphRAG (0 graph rows) outages would have tripped.
  - `lib/eval/diagnose.ts` (`classifyAnswer`) — codifies the symptom→stage→knob
    runbook as a pure, unit-tested classifier; `scripts/diagnose.ts` feeds it a live
    answer's why-trace and prints the ranked "where to fix it".
- **`scripts/cache-bench.ts`** — integration benchmark for the cache's actual
  purpose (consistency / hit-rate / latency / near-dup) — the test that would have
  caught the bugs above; the pass-rate ablation was blind to it.
- **Full-pipeline entrenchment eval.** `scripts/entrenchment-eval-full.ts` proves
  the whole compounding lifecycle against a live Postgres + a real LLM judge: a
  grounded answer is promoted through the judge gate to an `approved` card, then
  retracted to `deprecated` once its cluster turns net-negative. Complements the
  no-LLM `entrenchment-eval.ts` (brake only). Self-cleaning.
- **Eval harness measures the env-level components.** `scripts/seed-eval-corpus.ts`
  honours `KNOWLEDGE_ACCEPTANCE_EVALUATOR` at ingest, so the reranker and the
  acceptance evaluator can be ablated by flipping their flag across two runs — not
  just the AskProps components.

### Changed

- **Cache only stores `supported` answers (anti-hallucination defense A).** The
  cache write moved to *after* faithfulness/status are computed and is now gated on
  `status === "supported"` — previously any cited answer was cached *before*
  groundedness was even known, so a weakly-grounded/conflicted/hallucinated answer
  could be cached and then served back confidently + consistently to many agents
  (the cache amplifies whatever it holds). Deterministic; no extra cost.

### Removed

- **BREAKING: GraphRAG removed.** The graph-augmented retrieval path is gone —
  the `kl_graph_neighbors` query, the `KNOWLEDGE_GRAPHRAG_ENABLED` / `…_QAPLAN`
  flags, and the `graphContext` provider. Targeted verification showed it
  **non-functional**: it returned **0 graph neighbours** on every query, so it
  added cost, config surface, and failure surface while contributing nothing to
  retrieval (it was never the source of an answer). Reranking, by contrast, was
  *kept* — measured neutral on the small fixture but a genuine large-corpus
  feature, not dead weight. Removing GraphRAG shrinks the trust surface that the
  rest of this release is hardening. Deployments that set
  `KNOWLEDGE_GRAPHRAG_ENABLED` should drop the flag; no data migration is needed.

### Fixed

- **Answer cache never stored or hit (two bugs).** With `KNOWLEDGE_CACHE_ENABLED`
  on, the cache silently did nothing:
  1. `storeAnswer` interpolated the material-id JS array as drizzle's `($n)`
     value-list against the `uuid[]` column → Postgres `malformed array literal` →
     **every write failed**. Now bound as a `{a,b}::uuid[]` brace literal
     (`pgUuidArrayLiteral`, unit-tested).
  2. `lookupAnswer` read `tx.execute(...)` as a bare array, but it resolves to a
     `{ rows }` QueryResult → the row was always `undefined` → **every lookup
     missed** even with a matching row.
  Verified end-to-end (`scripts/cache-bench.ts`): cache went from 0% → **75% hit
  rate** (−75% LLM calls on a repeated-query workload) and answer consistency from
  3.5 distinct/question to **1.00** (byte-identical hits). The cache is off by
  default, so deployments running the default were unaffected.

### Docs

- **Definition of a *bad answer*.** `OPERATIONS.md §6` now opens by defining the
  category the runbook debugs (the dual of "what counts as knowledge"): AgenticMind
  promises *faithful + honestly-labeled + safe*, not *true*. A bad answer is a
  breach of that promise, judged on correctness × calibration — Tier 1 (the label
  lied: hallucination-as-grounded, confident-wrong, unsafe, stale-as-fresh),
  Tier 2 (quality, contract intact), Tier 3 (NOT bad — a wrong answer honestly
  marked `unsupported` kept the promise). Debug Tier 1 first.
- **Debugging runbook — "where do I fix it?"** `OPERATIONS.md` gains a
  symptom→signal→stage→knob table answering the operability worry of a dozen
  toggleable components: every stage stamps an attributable signal on the answer
  (`status`, `servedBy`, `groundedness`, `contested`, `staleSourcesOnly`,
  `rerankUsed`, `phases[]`, citation trust/lifecycle), so a single bad answer
  localises to one stage and one knob. Start from `status` + `servedBy`.
- **`docs/evals.md` records the live numbers.** Full-suite baseline 224/234
  (95.7%, gate passed, citation precision/recall 100%, every safety bucket green);
  the promote→demote lifecycle measured green; and an ablation table showing
  contested-sources and Tier-B faithfulness each contribute +1.6 pts while cards
  and cache are correctness-neutral (latency/efficiency) on the fixture corpus.
  The reranker also measured **+0.0** on the fixture (a scale feature the small
  corpus can't exercise — kept, not cut), and the acceptance evaluator held **29%**
  of cards as `candidate` (a governance control, retrieval-neutral). Verdict: only the
  two LLM-judge correctness features move the pass rate here; nothing is cut without
  a corpus that exercises it.
- **Abstention posture documented.** `docs/evals.md` explains that out-of-corpus
  queries are surfaced as `unsupported` / `groundedness = 0` (gate-able) by
  default, and hard `abstained` decline is opt-in (no sources, refusal phrasing,
  or a `KNOWLEDGE_ANSWER_POLICY` `minGroundedness`) — a deliberate, unit-tested
  *surface-not-decide* boundary, not an overconfidence defect.

## [0.11.0] — 2026-06-10

The **anti-entrenchment** release: the compounding loop gains a brake. Promotion
was always judge-gated on the way in; now a promoted answer the community later
turns against is retracted on the way out — measured end-to-end on a live run.
Still drop-in (DB + `OPENAI_KEY`); the new sweep is off by default.

### Added

- **Anti-entrenchment demotion sweep.** Closes the feedback-loop's open end. The
  compounding loop promotes a popular, judge-grounded answer into a `resolution`
  card; this is its brake. The worker sweep (`KNOWLEDGE_DEMOTION_ENABLED`, default
  off) demotes a promoted card to `deprecated` once its cluster's aggregate
  feedback score falls to/below a negative floor (`DEMOTION_SCORE_THRESHOLD`,
  −0.7) over at least `DEMOTION_MIN_FEEDBACK` (5) signals — so a once-popular
  answer the community later rejects stops surfacing. The card is kept (audit
  trail intact), not deleted. The decision rule (`shouldDemote`) is pure and
  unit-tested; the sweep is the thin DB executor.
- **Runnable entrenchment eval.** `scripts/entrenchment-eval.ts` proves the
  demotion half end-to-end against a live Postgres — it seeds a promoted card,
  drives its cluster net-negative, runs the sweep, and asserts the card was
  retracted. Deterministic (no LLM), self-cleaning (deletes its seed rows),
  needs only `DATABASE_URL`. The full-pipeline variant (promoter LLM judge in +
  brake out) remains the next step; documented in `docs/evals.md`.

## [0.10.0] — 2026-06-10

The **Knowledge Unit + safety** release: a written contract for what may become
stored knowledge, the admission machinery to enforce it, and an expanded,
eval-first safety net — every new risk measured against a live run before
anything was claimed. Still drop-in (DB + `OPENAI_KEY`); new behaviour is
off/neutral by default, except PII redaction, which is on because leaking PII is
a defect.

### Added

- **The Knowledge Unit contract.** A new `docs/knowledge-unit.md` defines what
  counts as stored knowledge — `Claim + Evidence + Scope + Validity + Reuse +
  Lifecycle`, the doctrine "conversation = evidence", the 10-point acceptance
  contract — and draws the line: the generic substrate stays domain-neutral;
  domain typologies, audience permissions, and reuse modes belong to the product
  layer above.
- **Card admission lifecycle.** Knowledge cards gain a `status`
  (`candidate | reviewed | approved | rejected | deprecated | archived`, default
  `approved`); retrieval excludes rejected/deprecated/archived so demoted
  knowledge never surfaces (migration `0007`).
- **Card provenance.** Cards record evidence `authority`
  (self_declared … external_source) and a confidence `method` + `reason`
  (migration `0008`).
- **Acceptance evaluator.** A flag-gated second-stage LLM gate at ingest
  (`KNOWLEDGE_ACCEPTANCE_EVALUATOR`, default off): per extracted card,
  accept → stored, reject → dropped, merge/human_review → held as `candidate`.
- **Eval-first safety net.** New failure-mode buckets, each **measured against a
  live Postgres + LLM run**: `pii_leak`, `opinion_vs_fact` (via a new Level-2
  binary judge wired into the runner), and `answer_cache_false_hit` (a primer +
  near-query cache guard). Citation precision/recall and the trust buckets from
  the previous cycle are exercised too.

### Security

- **Answer-side PII redaction — on by default.** The answer text **and** citation
  snippets are scrubbed of email/phone/card/SSN/IPv4 before they leave the engine
  and before caching. A `pii_leak` eval measured a real leak (PII was protected
  on input but echoed on output); this closes it. Opt out with
  `KNOWLEDGE_PII_REDACTION=false` only where raw contact info is intended.

### Measured (not claimed)

- On the benchmark, `opinion_vs_fact` and `answer_cache_false_hit` came back
  green: the engine attributes opinions rather than asserting them as fact, and
  the answer cache does not serve a near-but-different question's answer at the
  current threshold. These are eval results, not absolute guarantees.

[0.10.0]: https://github.com/Moai-Team-LLC/AgenticMind/releases/tag/v0.10.0

## [0.9.0] — 2026-06-08

The **auditable-contract** release: the engine's faithfulness signals become a
single verdict an agent can gate on and a policy an operator can enforce, source
trust is modelled and made visible, and every new signal is provable by the eval
harness. Still drop-in to deploy — DB + `OPENAI_KEY`, no new runtime stack; every
new behaviour is off/neutral by default.

### Added

- **Answer faithfulness, two tiers.** Tier-A structural groundedness +
  `unsupportedClaims` + honest `abstained`, computed for free on every answer;
  Tier-B semantic entailment of each cited claim against its snippet
  (`semanticGroundedness`, `contradictedClaims`) behind `KNOWLEDGE_FAITHFULNESS_TIER_B`.
- **A single answer `status`.** `supported | partial | unsupported | conflicted |
  needs_review`, derived from the signals — the one field an agent gates on.
- **Answer policy enforcement.** `KNOWLEDGE_ANSWER_POLICY` (JSON, default unset)
  blocks under-grounded answers and review-gates conflicted / cited-but-unentailed
  ones, with the decision attached to the trace.
- **Contested sources on `kl_ask_global`.** Facts the retrieved sources disagree
  on are surfaced (each side tagged with source + date), not silently resolved —
  behind `KNOWLEDGE_CONTESTED_SOURCES`. Complements `mem_recall`'s `contested`.
- **Source lifecycle + trust tier.** Materials carry a content lifecycle
  (`active | deprecated | superseded | archived`) and a trust tier; retrieval
  down-weights stale/low-trust sources, citations and contested sides expose it,
  an answer resting only on stale sources is flagged (`staleSourcesOnly` →
  `needs_review`), and both are settable at ingest via `kl_ingest`. Migration `0006`.
- **Self-improving read path.** `mem_forget`, corpus-adaptive retrieval tuning,
  and a closed loop that folds net-positively-signalled real queries into the
  tuner's eval set (opt-in `KNOWLEDGE_EVAL_HARVEST`; migration `0005`).
- **Eval discipline.** Citation precision/recall metrics + gold-relevance gates,
  and validated failure-mode buckets for conflicting sources, stale versions, and
  source hierarchy.
- **Multi-tenant hardening.** A cross-tenant RLS leakage eval that blocks CI, and
  a least-privilege app role (`DATABASE_APP_ROLE`, migration `0004`) so RLS holds
  even on an owner connection.
- **Cost controls.** Per-run output ceiling + per-call token usage in the trace.
- **Embeddings.** Optional `dimensions` (`EMBED_SEND_DIMENSIONS`) so OpenAI's
  `text-embedding-3-*` models can serve the schema's 1024 dims.
- **Operations & docs.** A published docs site (MkDocs), security model + MCP
  client cookbook, a config-knobs reference, and supply-chain signing (cosign +
  SBOM + SLSA provenance) on the multi-arch release images.

### Changed

- **MCP tool contract `1.2.0` → `1.8.0`** (all additive — existing clients
  unaffected): `kl_search` gains `queries` + `tokenBudget`; answers gain
  `status`, `contested`, `effectiveConfidence`, `semanticGroundedness`,
  `contradictedClaims`, `staleSourcesOnly`, and citation `lifecycle`/`trustTier`;
  `kl_ingest` gains `lifecycle` + `trustTier`.

### Security

- Synthesis hardened against indirect prompt injection carried in source content.

[0.9.0]: https://github.com/Moai-Team-LLC/AgenticMind/releases/tag/v0.9.0

## [0.8.0] — 2026-06-05

### Added

- **Contested beliefs surfaced on recall.** `mem_recall` now returns a
  `contested` list: any recalled fact where sources disagree (same
  subject+predicate, different objects), each competing variant tagged with its
  source actor and recording date. The agent can flag a dispute instead of
  silently trusting one side.
- **Time-decayed belief confidence.** Each recalled belief carries an
  `effectiveConfidence` — its stored confidence after exponential time-decay
  (90-day half-life). A belief that is not re-asserted loses weight as it ages
  (recency is trust); re-assertion resets it. Prefer it over raw `confidence`
  when deciding how much to trust a fact.
- **Batch + token-budget retrieval.** `kl_search` accepts a batch of `queries`
  fanned out in one round-trip (results merged and deduped by chunk, best score
  wins) and an optional `tokenBudget` to return the best ~N tokens of context
  instead of a fixed passage count.
- **Opt-in multi-tenant isolation.** Every knowledge table gains a `tenant_id`
  column and a Postgres row-level-security policy (migration `0003`); MCP tokens
  carry a tenant and each request runs inside a tenant context, so RLS scopes
  every read and write below the application and the model. Single-tenant
  deployments configure nothing — rows carry the default tenant and it just
  works. (Multi-tenant enforcement requires the app to connect as a
  non-superuser database role, since superusers bypass RLS.)
- **Multi-arch container images.** The release image build now publishes
  `linux/amd64` **and** `linux/arm64`, so `docker pull`/`run` works unchanged on
  Apple Silicon dev machines and arm64 cloud (Graviton/Ampere) without a
  `--platform` flag.
- **Contributor CLA gate and one-command quickstart.** A CLA check guards
  contributions, and a no-clone quickstart script stands the stack up from the
  published images. Engineering deep-dive blog posts document the why-trace,
  Postgres-only, and provenance design choices.

### Changed

- **MCP tool contract bumped 1.2.0 → 1.3.0** (additive — existing clients are
  unaffected): `kl_search` gains optional `queries` and `tokenBudget`;
  `mem_recall` results gain `contested` and `effectiveConfidence`.

[0.8.0]: https://github.com/Moai-Team-LLC/AgenticMind/releases/tag/v0.8.0

## [0.7.0] — 2026-06-04

### Added

- **Optional per-language full-text search.** `kl_ingest` gains an optional
  `language` parameter, and each material records its own `fts_config` (Postgres
  text-search configuration) so language-aware stemming can be applied per
  document — while the corpus default stays the language-neutral `simple` config.
  Migration `0002` adds the `fts_config` column. The MCP tool contract is bumped
  to **1.2.0** (additive — `language` is optional, existing clients unaffected).

### Changed

- **Blob storage is now provider-neutral S3, not DigitalOcean-specific.** The
  `SPACES_*` env vars are renamed to `S3_*` (`S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `S3_REGION`), and a new `S3_ENDPOINT`
  (+ `S3_FORCE_PATH_STYLE` for MinIO) points at any S3-compatible provider — AWS
  S3 (default), Cloudflare R2, MinIO, Backblaze B2, or DigitalOcean Spaces.
  Previously the endpoint was hard-coded to `*.digitaloceanspaces.com` with no
  way to override it. The old `SPACES_*` names are still read as a fallback, so
  existing configs keep working. The drop-in `deploy/` stack passes the `S3_*`
  vars through (off unless `S3_BUCKET` is set).

### Fixed

- **Blob storage is now genuinely optional.** The storage settings module
  validated its credentials eagerly at import and the MCP server imports it on
  boot — so a deployment without object-storage keys failed to start, despite the
  code having a no-op fallback. Storage config is now all-optional (import-safe);
  credentials are resolved only at the point of use and required only when
  `S3_BUCKET` is set (a bucket without keys now fails loudly instead of silently
  dropping bytes).

[0.7.0]: https://github.com/Moai-Team-LLC/AgenticMind/releases/tag/v0.7.0

## [0.6.0] — 2026-06-03

### Changed

- **BREAKING: OpenRouter is no longer a special-cased provider.** Chat is now a
  single OpenAI-compatible seam configured by `CHAT_BASE_URL` (default
  `https://api.openai.com/v1`) + `CHAT_API_KEY` — point it at OpenAI, Ollama,
  vLLM, **or OpenRouter** (`CHAT_BASE_URL=https://openrouter.ai/api/v1`). The
  `CHAT_PROVIDER` switch, the dedicated OpenRouter client (`@openrouter/ai-sdk-provider`),
  and `OPENROUTER_API_KEY` are gone; default models are now `gpt-4o-mini` / `gpt-4o`.
  No capability is lost — OpenRouter is still reachable via the base URL.
  **Migration:** OpenRouter users set `CHAT_BASE_URL=https://openrouter.ai/api/v1`,
  `CHAT_API_KEY=<openrouter-key>`, and `CHAT_MODEL_*` to OpenRouter slugs.
- **Rerank moved to native Cohere.** The optional cross-encoder now calls
  `api.cohere.com/v2/rerank` with `RERANK_API_KEY` + `RERANK_MODEL` (default
  `rerank-v3.5`), overridable via `RERANK_BASE_URL`. No OpenRouter needed. Off by
  default, so retrieval is unaffected unless you had rerank enabled.
- **`material.source` reduced to a single value, `manual`.** The dead
  crawl-connector origins (`http_url` / `google_drive` / `notion` / `telegram`),
  orphaned when the ingestion connectors were removed in 0.3.0, are gone from the
  `MaterialSource` type and the `materials_source_check` constraint. Migration
  `0001` remaps any legacy rows to `manual` before tightening the check, so it is
  safe on pre-0.3 databases. No MCP tool exposes source selection, so the tool
  contract (1.1.0) is unchanged.

### Fixed

- **Stale OpenRouter-era defaults and references purged.** The in-code model
  fallbacks used when `SKIP_VALIDATION` is set (the dev default) were still
  OpenRouter slugs (`openai/gpt-5-mini`, `google/gemini-3.1-flash-lite-preview`)
  that don't resolve against OpenAI — now `gpt-4o` / `gpt-4o-mini`, matching the
  zod defaults. Also swept lingering `OPENROUTER_API_KEY` / `CHAT_PROVIDER`
  mentions out of the docs, Dockerfiles, `setup.sh`, `turbo.json` (cache-key env),
  the calibrate/eval scripts, and a phantom `BullMQ` reference in the worker
  header (the worker is Postgres-only — no broker was ever shipped). The
  contributor guide now correctly describes the engine as language-neutral
  (multilingual bge-m3 + `simple` FTS), not English-only.

### Internal

- **Dropped internal Go-port provenance** from ~40 source-file comments (the
  knowledge layer was extracted from a closed Go service). Behavioral/parity
  notes were preserved; comments only, no code or behavior change.

[0.6.0]: https://github.com/Moai-Team-LLC/AgenticMind/releases/tag/v0.6.0

## [0.5.0] — 2026-06-03

### Added

- **Published container images** — a `release-images` workflow builds and pushes
  `ghcr.io/moai-team-llc/agenticmind-server` and `…-worker` to GHCR on each
  release (and on demand). Self-hosters can `docker pull` instead of
  clone-and-build.
- **`MCP_API_KEY` — one-key auth.** A static shared bearer for simple
  single-tenant self-host: set it, send it. No `issue-token`, no `AUTH_SECRET`,
  no DB token row; grants all scopes (constant-time compared). Minted JWTs remain
  the least-privilege, revocable path.
- **Drop-in deploy stack** — `deploy/docker-compose.yml` + `deploy/gen-secrets.sh`
  bring up Postgres → migrations → server → worker from the GHCR images, reusing
  your existing **OpenAI** key (no OpenRouter). `gen-secrets.sh` auto-generates
  the DB password and MCP key, so the only secret you supply is the OpenAI one
  you already have. See [`docs/DEPLOY.md`](docs/DEPLOY.md).

### Fixed

- **A dropped MCP client no longer crashes the server.** When a client aborts or
  times out mid-request, `mcp-handler` could write to the already-closed response
  stream (`Invalid state: Controller is already closed`), throwing
  asynchronously — outside any per-request `try/catch` — and exiting the process.
  One misbehaving client took down the whole knowledge service. The host now
  swallows that benign disconnect class (and only that class) at the process
  level via `isClientDisconnectError`; genuine faults stay loud and fatal.
- **Docker images build and run again.** `packageManager` had been set to `npm`,
  which made `turbo prune` look for a `package-lock.json` that isn't committed and
  broke the image build (_"Cannot prune without parsed lockfile"_) — reverted to
  `bun`. The images also moved off Alpine to a glibc base, because
  `onnxruntime-node` (the local-embeddings addon) cannot load on musl
  (_"__getauxval: symbol not found"_). The npm CI job installs Bun so Turbo can
  still orchestrate.

[0.5.0]: https://github.com/Moai-Team-LLC/AgenticMind/releases/tag/v0.5.0

## [0.4.1] — 2026-06-02

### Added

- **Blocked-CDN / offline embeddings** — `EMBED_HF_ENDPOINT` (a Hugging Face
  mirror such as `https://hf-mirror.com`) and `EMBED_CACHE_DIR` (a pre-seedable
  model cache) let the default in-process embedder work when the Hugging Face CDN
  (`cdn-lfs.huggingface.co` / `cas-bridge.xethub.hf.co`) is blocked or the host is
  air-gapped. See `docs/OPERATIONS.md` § Switching model providers.

[0.4.1]: https://github.com/Moai-Team-LLC/AgenticMind/releases/tag/v0.4.1

## [0.4.0] — 2026-06-02

### Added

- **`kl_forget` MCP tool** — the inverse of `kl_ingest`: permanently delete a
  material by its UUID and everything derived from it (chunks, embeddings, fact
  cards, graph mentions; best-effort blob cleanup). For retraction /
  right-to-erasure. Requires the new, elevated **`knowledge:admin`** scope
  (strictly above `knowledge:write`). The MCP tool contract is bumped to
  **1.1.0** (additive — existing clients are unaffected).
- **README polish** — an animated `kl_ask_global` demo and the AgenticMind logo
  in the header.

[0.4.0]: https://github.com/Moai-Team-LLC/AgenticMind/releases/tag/v0.4.0

## [0.3.0] — 2026-06-01

Runs on plain Node now — Bun is no longer required — and the knowledge layer is
leaner and strictly MCP-native.

### Added

- **Runtime-agnostic host** — the MCP server runs on plain **Node ≥22.18** (via
  `@hono/node-server`) or **Bun** (`Bun.serve`), behind a single Web-standard
  `fetch` handler. Server and worker scripts run on Node via `tsx`.
- **Package-manager-agnostic install** — install with **npm** or **bun**
  (`*` workspace specifiers + an `.npmrc` for peer resolution). A second CI job
  installs with npm on Node so the path can't silently rot; `bun.lock` stays the
  canonical lockfile.
- Community-health files (`GOVERNANCE`, `SUPPORT`, `ROADMAP`, `PUBLISHING`) and a
  live "See it work" demo in the README.

### Removed

- **The `http_url` ingestion connector** and its SSRF URL-fetcher. The substrate
  is MCP-native: agents carry their own connectors and feed the corpus via
  `kl_ingest`, so an outbound-fetch connector inside the substrate was redundant
  and an unnecessary SSRF surface. The `ingest` CLI keeps `--file` and `--text`.

### Fixed

- Stale migration references in `docs/OPERATIONS.md` after the migration squash.

[0.3.0]: https://github.com/Moai-Team-LLC/AgenticMind/releases/tag/v0.3.0

## [0.2.0] — 2026-06-01

The substrate is now provider-agnostic, multilingual, observable, and
eval-grounded — a quality, self-hostable knowledge & memory layer for agents.

### Added

- **Pluggable model providers** (`EmbeddingsProvider`, `ChatProvider`) — the
  default is a zero-key, offline, in-process **multilingual** embedding model
  (bge-m3, 1024-dim); chat works with OpenRouter or any OpenAI-compatible
  endpoint (Ollama, vLLM, …). OpenRouter is now one option, not a dependency.
- **OpenInference / OpenTelemetry tracing** of the ask pipeline and the worker
  compounding sweep — a portable why-trace (CHAIN → retrieve → synthesize) that
  exports to Phoenix / Langfuse / LangSmith. No-op until an OTLP endpoint is set.
- **Versioned MCP tool contract** (`MCP_CONTRACT_VERSION`, surfaced as
  `serverInfo.version`) with a snapshot guard test, `CONTRACT.md`, and a
  `server.json` registry manifest.
- **Multilingual prompt-injection detection** (EN + RU) in the input guard.
- **Eval suite** grounded in a vendored corpus: ≥50 cases per top-priority
  failure mode and ≥100 calibration labels, generated by a self-validating
  builder (`bun run build-eval`), plus `seed-eval` and `reembed` scripts.
- **Operations runbook** (`docs/OPERATIONS.md`), Conventional Commits enforced
  via commitlint + husky + CI.

### Changed

- **BREAKING:** embedding vectors are now **1024-dim** (was 1536) and the
  full-text search config is language-neutral (`simple`). Re-embed existing
  corpora (`bun run reembed`) and re-apply migrations.
- Knowledge-graph ontology and feedback-signal vocabulary generalized to a
  domain-neutral set.

[0.2.0]: https://github.com/Moai-Team-LLC/AgenticMind/releases/tag/v0.2.0
