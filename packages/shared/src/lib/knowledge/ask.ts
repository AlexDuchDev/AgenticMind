/**
 * /ask pipeline orchestration. Glues the pieces together:
 * query variants → embed → answer-cache lookup → hybrid retrieval (chunks
 * vector+BM25 blended, recency-boosted) + knowledge cards prepended → prompt →
 * chat → citation parsing → best-effort cache store. Env/DB-coupled; the pure
 * sub-pieces (synth core, blend, recency, cache keys) are unit-tested.
 */

import type { Transaction } from "@agenticmind/shared/database/client"
import type { CardHit } from "@agenticmind/shared/database/query/knowledge/cards"
import type { KnowledgeHit } from "@agenticmind/shared/database/query/knowledge/chunks"
import type { LlmModel } from "@agenticmind/shared/lib/ai/model"
import type { AnswerPolicy } from "@agenticmind/shared/lib/knowledge/answer-policy"
import type { HybridWeights } from "@agenticmind/shared/lib/knowledge/blend"
import type {
  ContestedFact,
  ContestedSourceInput,
} from "@agenticmind/shared/lib/knowledge/contested-sources"
import type { EntailmentClaim } from "@agenticmind/shared/lib/knowledge/faithfulness-entailment"
import type { RecencyConfig } from "@agenticmind/shared/lib/knowledge/recency"
import type {
  Answer,
  Citation,
  GraphContextRow,
  CallerContext,
  Source,
} from "@agenticmind/shared/lib/knowledge/synth"

import {
  lookupAnswer,
  storeAnswer,
} from "@agenticmind/shared/database/query/knowledge/answer-cache"
import { recordAskTelemetry } from "@agenticmind/shared/database/query/knowledge/ask-telemetry"
import { searchCards, searchCardsBm25 } from "@agenticmind/shared/database/query/knowledge/cards"
import { searchChunks, searchChunksBm25 } from "@agenticmind/shared/database/query/knowledge/chunks"
import { getMaterial } from "@agenticmind/shared/database/query/knowledge/materials"
import {
  fingerprintSources,
  hashQuestion,
} from "@agenticmind/shared/lib/knowledge/answer-cache-keys"
import {
  evaluatePolicy,
  POLICY_BLOCK_MESSAGE,
} from "@agenticmind/shared/lib/knowledge/answer-policy"
import {
  deriveAnswerStatus,
  restsOnlyOnStaleSources,
} from "@agenticmind/shared/lib/knowledge/answer-status"
import { blendHybrid, clamp01, defaultHybridWeights } from "@agenticmind/shared/lib/knowledge/blend"
import {
  classifyComplexity,
  modelForComplexity,
} from "@agenticmind/shared/lib/knowledge/complexity"
import {
  buildContestedUser,
  CONTESTED_SYSTEM,
  contestedResponseSchema,
  toContestedFacts,
} from "@agenticmind/shared/lib/knowledge/contested-sources"
import {
  scoreFaithfulness,
  supportedClaims,
  ungroundedFigures,
  ungroundedQuotes,
  weaklyAttributedClaims,
} from "@agenticmind/shared/lib/knowledge/faithfulness"
import {
  aggregateEntailment,
  buildEntailmentUser,
  ENTAILMENT_SYSTEM,
  entailmentResponseSchema,
} from "@agenticmind/shared/lib/knowledge/faithfulness-entailment"
import { detectOutputLeak, redactPii } from "@agenticmind/shared/lib/knowledge/guard"
import {
  checkJudgeGeneratorDecorrelation,
  resolveJudgeModel,
} from "@agenticmind/shared/lib/knowledge/judge-model"
import {
  completeKnowledge,
  completeKnowledgeJson,
  embedKnowledgeText,
} from "@agenticmind/shared/lib/knowledge/llm"
import {
  CARD_WEIGHT_BOOST,
  RETRIEVAL_MIN_CONFIDENCE,
} from "@agenticmind/shared/lib/knowledge/ontology"
import { boost, defaultRecencyConfig } from "@agenticmind/shared/lib/knowledge/recency"
import { rerankPairs } from "@agenticmind/shared/lib/knowledge/rerank"
import { applyTrust } from "@agenticmind/shared/lib/knowledge/source-trust"
import { queryVariants } from "@agenticmind/shared/lib/knowledge/stopwords"
import {
  buildPromptWithGraphContext,
  buildSystemPromptWithContext,
  classifyServedBy,
  DEFAULT_TOP_K,
  MAX_CARD_SOURCES,
  MAX_GRAPH_CONTEXT_ROWS,
  parseCitations,
  SERVED_BY_CACHE,
  SOURCE_ORIGIN_CARD,
  SOURCE_ORIGIN_CHUNK,
} from "@agenticmind/shared/lib/knowledge/synth"
import {
  Attr,
  recordChildSpan,
  setAgentAttributes,
  setInput,
  setOutput,
  SpanKind,
  withSpan,
} from "@agenticmind/shared/lib/observability/trace"
import { aiSettings } from "@agenticmind/shared/settings/ai-settings"
import { okAsync, ResultAsync } from "neverthrow"

export type AskError = { readonly type: "ask_error"; readonly message: string }
const askError = (message: string): AskError => {
  return { type: "ask_error", message }
}

export type AskProps = {
  tx: Transaction
  question: string
  /** Asker id, recorded on the telemetry row (nullable). */
  memberId?: string | null
  memberContext?: CallerContext | null
  cardsEnabled?: boolean
  cacheEnabled?: boolean
  topK?: number
  chatModel?: LlmModel
  /** Hybrid vector/BM25 fusion weights; defaults to the engine default. Tunable per corpus. */
  hybridWeights?: HybridWeights
  /** Recency-boost config applied to chunk scores; defaults to the engine default. Tunable. */
  recencyConfig?: RecencyConfig
  /** Rerank pool size (top-N kept by the cross-encoder); defaults to topK. */
  rerankTopN?: number
  /** Optional Tier-2 graph-context provider (best-effort). */
  graphContext?: (question: string, queryEmbedding: number[]) => Promise<GraphContextRow[]>
  /** Tier-B faithfulness: run the semantic-entailment judge (one extra LLM call).
   * Default off — the structural Tier-A signals are always computed for free. */
  faithfulnessTierB?: boolean
  /** Contested-sources detection: run a judge pass that surfaces facts where the
   * retrieved sources disagree (one extra LLM call). Default off. */
  contestedSources?: boolean
  /** Eval-harvest: persist the raw question on the telemetry row so signalled real
   * queries can be replayed by the tuner. Default off (privacy: hash-only). */
  evalHarvest?: boolean
  /** Answer policy (KNOWLEDGE_ANSWER_POLICY): enforce a groundedness floor / flag
   * conflicted answers for review. Unset = no enforcement (today's behaviour). */
  answerPolicy?: AnswerPolicy
  /** Redact PII from the answer + citation snippets. Default on (only `false`
   * disables) — leaking PII is a defect, not a feature. */
  piiRedaction?: boolean
}

type MatMeta = { title: string; updatedAt: Date | null; lifecycle: string; trustTier: number }

const resolveMeta = async (
  tx: Transaction,
  materialId: string,
  cache: Map<string, MatMeta>,
): Promise<MatMeta> => {
  const cached = cache.get(materialId)
  if (cached !== undefined) {
    return cached
  }
  const res = await getMaterial({ tx, id: materialId })
  const meta: MatMeta =
    res.isOk() && res.value !== null
      ? {
          title: res.value.title,
          updatedAt: res.value.updatedAt,
          lifecycle: res.value.lifecycle,
          trustTier: res.value.trustTier,
        }
      : { title: "", updatedAt: null, lifecycle: "active", trustTier: 0 }
  cache.set(materialId, meta)
  return meta
}

/** Decorate chunk hits with title + recency- and trust-weighted score, sorted + renumbered. */
const decorate = async (
  tx: Transaction,
  hits: KnowledgeHit[],
  cache: Map<string, MatMeta>,
  cfg: RecencyConfig,
): Promise<Source[]> => {
  const sources: Source[] = []
  for (const h of hits) {
    const meta = await resolveMeta(tx, h.materialId, cache)
    sources.push({
      number: 0,
      chunkId: h.chunkId,
      materialId: h.materialId,
      title: meta.title,
      body: h.body,
      score: applyTrust(boost(h.score, meta.updatedAt, cfg), meta.lifecycle, meta.trustTier),
      updatedAt: meta.updatedAt,
      origin: SOURCE_ORIGIN_CHUNK,
      lifecycle: meta.lifecycle,
      trustTier: meta.trustTier,
    })
  }
  sources.sort((a, b) => b.score - a.score)
  for (const [i, s] of sources.entries()) {
    s.number = i + 1
  }
  return sources
}

/** Hybrid-blend cards (with CardWeightBoost), return up to MAX_CARD_SOURCES as Sources. */
const fetchCardSources = async (
  props: AskProps,
  queryEmbedding: number[],
  variants: string[],
  cache: Map<string, MatMeta>,
): Promise<Source[]> => {
  const pool = Math.max(MAX_CARD_SOURCES, Math.min((props.topK ?? DEFAULT_TOP_K) * 2, 20))
  const w = props.hybridWeights ?? defaultHybridWeights()
  const vec = await searchCards({
    tx: props.tx,
    queryEmbedding,
    limit: pool,
    minConfidence: RETRIEVAL_MIN_CONFIDENCE,
  })
  const bm = await searchCardsBm25({
    tx: props.tx,
    query: props.question,
    variants,
    limit: pool,
    minConfidence: RETRIEVAL_MIN_CONFIDENCE,
  })
  const byId = new Map<string, { hit: CardHit; score: number }>()
  if (vec.isOk()) {
    for (const h of vec.value) {
      byId.set(h.cardId, { hit: h, score: w.vector * clamp01(h.score) * CARD_WEIGHT_BOOST })
    }
  }
  if (bm.isOk()) {
    for (const h of bm.value) {
      const add = w.bm25 * clamp01(h.score) * CARD_WEIGHT_BOOST
      const existing = byId.get(h.cardId)
      if (existing !== undefined) {
        existing.score += add
      } else {
        byId.set(h.cardId, { hit: h, score: add })
      }
    }
  }
  if (byId.size === 0) {
    return []
  }
  const ranked = [...byId.values()].toSorted((a, b) => b.score - a.score).slice(0, MAX_CARD_SOURCES)

  const out: Source[] = []
  for (const { hit, score } of ranked) {
    const meta = await resolveMeta(props.tx, hit.materialId, cache)
    out.push({
      number: 0,
      chunkId: hit.cardId, // Overload: card id in the chunk-id slot for the prompt path
      materialId: hit.materialId,
      title: meta.title,
      body: hit.body,
      score: applyTrust(score, meta.lifecycle, meta.trustTier),
      updatedAt: meta.updatedAt,
      origin: SOURCE_ORIGIN_CARD,
      spanStart: hit.spanStart,
      spanEnd: hit.spanEnd,
      confidence: hit.confidence,
      lifecycle: meta.lifecycle,
      trustTier: meta.trustTier,
    })
  }
  return out
}

/** Scrubs PII (email/phone/card/SSN/IPv4) from the answer text + each citation
 * snippet — unless redaction is explicitly disabled. Pure; reuses the shared
 * `redactPii` detector. Default on (only `enabled === false` skips it). */
const maybeRedactAnswerPii = (
  enabled: boolean | undefined,
  answerText: string,
  citations: Citation[],
): { answerText: string; citations: Citation[] } => {
  if (enabled === false) {
    return { answerText, citations }
  }
  return {
    answerText: redactPii(answerText).redacted,
    citations: citations.map((c) => {
      const r = redactPii(c.snippet)
      return r.found.length > 0 ? { ...c, snippet: r.redacted } : c
    }),
  }
}

/** Best-effort graph-context prelude: resolves the optional GraphRAG provider,
 * capped and fail-soft (a graph failure never fails the answer). Returns [] when
 * no provider is wired (the default). Extracted from runAsk to keep its branch
 * count under the complexity ceiling. */
const resolveGraphContext = async (
  props: AskProps,
  question: string,
  queryVec: number[],
): Promise<GraphContextRow[]> => {
  if (props.graphContext === undefined) {
    return []
  }
  try {
    const rows = await props.graphContext(question, queryVec)
    return rows.slice(0, MAX_GRAPH_CONTEXT_ROWS)
  } catch (error) {
    console.warn(`ask: graph context failed: ${String(error)}`)
    return []
  }
}

const runAsk = async (props: AskProps): Promise<Answer> => {
  const question = props.question.trim()
  if (question === "") {
    throw askError("empty question")
  }
  const topK = props.topK !== undefined && props.topK > 0 ? props.topK : DEFAULT_TOP_K
  const t0 = Date.now()
  const phases: { phase: string; ms: number }[] = []
  const mark = (phase: string, since: number): void => {
    phases.push({ phase, ms: Date.now() - since })
  }

  let ts = Date.now()
  const variants = queryVariants(question)
  const embedQuery = variants.length > 0 ? variants.join(" ") : question
  const embedded = await embedKnowledgeText(embedQuery)
  if (embedded.isErr()) {
    throw askError(`embed: ${embedded.error.message}`)
  }
  const queryVec = embedded.value
  mark("embed", ts)

  // Tier-1: answer-cache lookup (best-effort early return).
  ts = Date.now()
  if (props.cacheEnabled === true) {
    const cached = await lookupAnswer({ tx: props.tx, question, queryEmbedding: queryVec })
    if (cached.isOk() && cached.value !== null) {
      mark("cache_hit", ts)
      // Cached answers always carry >=1 citation (the store gate); recompute the
      // pure Tier-A faithfulness signals so a cache hit is indistinguishable from
      // a fresh answer to the caller.
      const faith = scoreFaithfulness(
        cached.value.answerText,
        cached.value.citations,
        cached.value.citations.length,
      )
      const cachedStaleOnly = restsOnlyOnStaleSources(cached.value.citations)
      const cachedUngroundedFigs = ungroundedFigures(
        cached.value.answerText,
        cached.value.citations.map((c) => c.snippet ?? ""),
      )
      const cachedWeakAttribution = weaklyAttributedClaims(
        cached.value.answerText,
        cached.value.citations,
      )
      const cachedUngroundedQuotes = ungroundedQuotes(
        cached.value.answerText,
        cached.value.citations.map((c) => c.snippet ?? ""),
      )
      const cachedAnswer: Answer = {
        answer: cached.value.answerText,
        citations: cached.value.citations,
        retrievalMs: Date.now() - t0,
        generationMs: 0,
        model: cached.value.answerModel,
        servedBy: SERVED_BY_CACHE,
        phases,
        groundedness: faith.groundedness,
        unsupportedClaims: faith.unsupportedClaims,
        abstained: faith.abstained,
        status: deriveAnswerStatus({
          groundedness: faith.groundedness,
          abstained: faith.abstained,
          staleSourcesOnly: cachedStaleOnly,
          ungroundedFigures: cachedUngroundedFigs,
          weaklyAttributedClaims: cachedWeakAttribution,
          ungroundedQuotes: cachedUngroundedQuotes,
        }),
        staleSourcesOnly: cachedStaleOnly,
        ungroundedFigures: cachedUngroundedFigs,
        weaklyAttributedClaims: cachedWeakAttribution,
        ungroundedQuotes: cachedUngroundedQuotes,
      }
      return applyAnswerPolicy(cachedAnswer, props.answerPolicy)
    }
    if (cached.isErr()) {
      console.warn(`ask: cache lookup failed: ${cached.error.message}`)
    }
  }
  mark("cache_miss", ts)

  // Hybrid retrieval over chunks.
  ts = Date.now()
  const retrieveStartMs = ts
  const pool = Math.max(topK, Math.min(topK * 3, 30))
  const vectorHits = await searchChunks({ tx: props.tx, queryEmbedding: queryVec, limit: pool })
  if (vectorHits.isErr()) {
    throw askError(`search: ${vectorHits.error.message}`)
  }
  const bm25 = await searchChunksBm25({ tx: props.tx, query: question, variants, limit: pool })
  const bm25Hits = bm25.isOk() ? bm25.value : []
  const fused = blendHybrid(
    vectorHits.value,
    bm25Hits,
    props.hybridWeights ?? defaultHybridWeights(),
  )
  const hits = fused.map((f) => {
    return { ...f.hit, score: f.fusedScore }
  })

  const matCache = new Map<string, MatMeta>()
  let sources = await decorate(
    props.tx,
    hits,
    matCache,
    props.recencyConfig ?? defaultRecencyConfig(),
  )

  // Tier-1: prepend knowledge cards ahead of raw chunks.
  if (props.cardsEnabled === true) {
    const cardSources = await fetchCardSources(props, queryVec, variants, matCache)
    if (cardSources.length > 0) {
      sources = [...cardSources, ...sources]
    }
  }
  mark("retrieve", ts)

  // Reranker: narrow the retrieval pool to the top-K the synthesiser sees,
  // Ordered by cross-encoder relevance. Falls back to fused order on failure.
  ts = Date.now()
  let rerankUsed = false
  let rerankLatencyMs: number | undefined
  if (sources.length > topK) {
    const pairs = sources.map((s) => {
      return { body: s.body, item: s }
    })
    const r = await rerankPairs({ query: question, pairs, topN: props.rerankTopN ?? topK }).match(
      (ranked) => {
        return { items: ranked.map((p) => p.item), used: true }
      },
      () => {
        return { items: pairs.map((p) => p.item), used: false }
      },
    )
    sources = r.items.slice(0, topK)
    rerankUsed = r.used
    rerankLatencyMs = Date.now() - ts
  }
  for (const [i, s] of sources.entries()) {
    s.number = i + 1
  }
  mark("rerank", ts)
  recordChildSpan("retrieve", SpanKind.RETRIEVER, retrieveStartMs, Date.now(), {
    [Attr.RETRIEVAL_DOC_COUNT]: sources.length,
  })

  // Tier-2: optional graph-context prelude (best-effort).
  const graphContext = await resolveGraphContext(props, question, queryVec)

  const retrievalMs = Date.now() - t0
  // Adaptive model routing: simple fact-lookups go to the cheap/fast model,
  // Multi-part / comparative / long questions to the flagship. Caller override wins.
  const model = props.chatModel ?? modelForComplexity(classifyComplexity(question))
  const system = buildSystemPromptWithContext(props.memberContext ?? null)
  ts = Date.now()
  const completion = await completeKnowledge({
    system,
    user: buildPromptWithGraphContext(question, sources, graphContext),
    model,
    purpose: "knowledge ask",
  })
  if (completion.isErr()) {
    throw askError(`chat: ${completion.error.message}`)
  }
  const generationMs = Date.now() - ts
  mark("synth", ts)
  recordChildSpan("synthesize", SpanKind.LLM, ts, ts + generationMs, {
    [Attr.LLM_MODEL]: model,
  })

  // Output guard: a grounded answer must never echo the system prompt. On a
  // Leak we drop the answer (and its citations) for a safe fallback.
  ts = Date.now()
  let answerText = completion.value
  const leak = detectOutputLeak(answerText, system)
  if (leak.leaked) {
    console.warn(`ask: output leak blocked (${leak.reason})`)
    answerText = "I couldn't produce a safe answer for that."
  }
  let citations = leak.leaked ? [] : parseCitations(answerText, sources)
  // Output PII redaction (default on): the answer + citation snippets must never
  // leak raw PII (email/phone/card/SSN/IPv4) even when a source contains it.
  // Applied before caching, so cached answers are clean too. Opt out per
  // deployment (KNOWLEDGE_PII_REDACTION=false) when raw contact info is intended.
  const redacted = maybeRedactAnswerPii(props.piiRedaction, answerText, citations)
  answerText = redacted.answerText
  citations = redacted.citations
  mark("output_filter", ts)

  // Tier-A faithfulness: structural groundedness + abstention, computed from the
  // already-parsed citations (no extra LLM call, no added latency).
  const faith = scoreFaithfulness(answerText, citations, sources.length)
  // Tier-B (flag-gated, best-effort): semantic entailment of each cited claim
  // against its own snippet. Returns {} when off / nothing to check / judge fails,
  // so it spreads cleanly and never fails the answer.
  // Decorrelate the verify judges from the generator (doctrine §1a): when a
  // CHAT_JUDGE_MODEL of a different family is configured, the judges run on it instead
  // of the answer model, so a same-family second pass does not co-sign its blind spots.
  const judgeModel = resolveJudgeModel(model, aiSettings.CHAT_JUDGE_MODEL)
  warnIfJudgeCorrelated(props, model, judgeModel, aiSettings.CHAT_JUDGE_MODEL)
  const tierBFields = await tierBFaithfulness(props, answerText, citations, judgeModel)
  // Contested-sources (flag-gated, best-effort): surface facts the retrieved
  // sources disagree on instead of silently trusting the recency-preferred one.
  const contestedFields = await contestedSourcesCheck(props, sources, judgeModel)
  const staleSourcesOnly = restsOnlyOnStaleSources(citations)
  // Deterministic numeric verbatim check (Tier-A): figures asserted but absent
  // from every cited snippet — a fabricated number escalates to needs_review.
  const ungroundedFigs = ungroundedFigures(
    answerText,
    citations.map((c) => c.snippet ?? ""),
  )
  // Deterministic citation-attribution check (Tier-A): a substantial cited claim
  // whose snippet shares no salient word — a mis-attributed citation.
  const weakAttribution = weaklyAttributedClaims(answerText, citations)
  // Deterministic quote check (Tier-A): a quoted phrase absent verbatim from sources.
  const ungroundedQuotesList = ungroundedQuotes(
    answerText,
    citations.map((c) => c.snippet ?? ""),
  )
  const status = deriveAnswerStatus({
    groundedness: faith.groundedness,
    semanticGroundedness: tierBFields.semanticGroundedness,
    contradictedClaims: tierBFields.contradictedClaims,
    contested: contestedFields.contested,
    abstained: faith.abstained,
    staleSourcesOnly,
    ungroundedFigures: ungroundedFigs,
    weaklyAttributedClaims: weakAttribution,
    ungroundedQuotes: ungroundedQuotesList,
  })

  // Tier-1 cache store — gated on quality. Done AFTER faithfulness/status so a
  // hallucinated or weakly-grounded answer is never cached and then served back
  // confidently + consistently (cache amplifies whatever it stores). Only a fully
  // `supported` answer (grounded, no conflict/contradiction/staleness) is cached.
  if (props.cacheEnabled === true && citations.length > 0 && status === "supported") {
    const updatedByMat = new Map<string, Date | null>()
    for (const s of sources) {
      updatedByMat.set(s.materialId, s.updatedAt)
    }
    const citedIds = [...new Set(citations.map((c) => c.materialId))]
    const fingerprint = fingerprintSources(
      citedIds.map((id) => {
        return { materialId: id, updatedAt: updatedByMat.get(id) ?? new Date(0) }
      }),
    )
    const stored = await storeAnswer({
      tx: props.tx,
      entry: {
        questionHash: hashQuestion(question),
        questionText: question,
        questionEmbedding: queryVec,
        answerText,
        citations,
        sourceMaterialIds: citedIds,
        sourceFingerprint: fingerprint,
        answerModel: model,
      },
    })
    if (stored.isErr()) {
      console.warn(`ask: cache store failed: ${stored.error.message}`)
    }
  }

  const answer: Answer = {
    answer: answerText,
    citations,
    retrievalMs,
    generationMs,
    model,
    servedBy: classifyServedBy(citations, sources),
    graphContextRows: graphContext.length,
    rerankUsed,
    rerankLatencyMs,
    phases,
    groundedness: faith.groundedness,
    unsupportedClaims: faith.unsupportedClaims,
    abstained: faith.abstained,
    ...tierBFields,
    ...contestedFields,
    status,
    staleSourcesOnly,
    ungroundedFigures: ungroundedFigs,
    weaklyAttributedClaims: weakAttribution,
    ungroundedQuotes: ungroundedQuotesList,
  }
  return applyAnswerPolicy(answer, props.answerPolicy)
}

/**
 * Applies the configured answer policy to a finished Answer. No policy → returned
 * unchanged. "block" → the answer is replaced by a refusal (citations dropped,
 * status downgraded to unsupported, abstained set); "review"/"allow" → text is
 * unchanged and the decision is attached for the trace.
 */
const applyAnswerPolicy = (answer: Answer, policy: AnswerPolicy | undefined): Answer => {
  if (policy === undefined) {
    return answer
  }
  const decision = evaluatePolicy(policy, {
    status: answer.status ?? "supported",
    groundedness: answer.groundedness,
    semanticGroundedness: answer.semanticGroundedness,
  })
  if (decision.action === "block") {
    return {
      ...answer,
      answer: POLICY_BLOCK_MESSAGE,
      citations: [],
      abstained: true,
      status: "unsupported",
      policy: decision,
    }
  }
  return { ...answer, policy: decision }
}

/**
 * Contested-sources judge: one batched call asking whether any two retrieved
 * sources directly disagree on a fact, returning each side tagged with its source
 * title + date. Best-effort — returns `{}` when the flag is off, there are fewer
 * than two sources, or the judge call fails, so it spreads straight into the
 * Answer and never breaks the answer path.
 */
/**
 * Fail loud on a mis-decorrelated judge (doctrine §1a): if an operator configured a
 * distinct CHAT_JUDGE_MODEL but it still resolves to the generator's family, the second
 * pass co-signs the same blind spots — the seam looks "on" while decorrelation is not
 * real. An unset CHAT_JUDGE_MODEL is the intended honest-degraded path and is not warned;
 * a routed-but-unreachable foreign judge already surfaces via the per-call `isErr` warns.
 */
export const warnIfJudgeCorrelated = (
  judgeFlags: Pick<AskProps, "faithfulnessTierB" | "contestedSources">,
  generatorModel: LlmModel,
  judgeModel: LlmModel,
  configuredJudge: string | undefined,
): void => {
  const judgesWillRun =
    judgeFlags.faithfulnessTierB === true || judgeFlags.contestedSources === true
  if (!judgesWillRun || configuredJudge === undefined || configuredJudge.length === 0) {
    return
  }
  const decorr = checkJudgeGeneratorDecorrelation(generatorModel, judgeModel)
  if (!decorr.decorrelated) {
    console.warn(`ask: judge decorrelation OFF — ${decorr.reason}`)
  }
}

const contestedSourcesCheck = async (
  props: AskProps,
  sources: readonly Source[],
  model: LlmModel,
): Promise<{ contested?: ContestedFact[] }> => {
  if (props.contestedSources !== true || sources.length < 2) {
    return {}
  }
  const inputs: ContestedSourceInput[] = sources.map((s) => {
    return {
      number: s.number,
      title: s.title,
      body: s.body,
      updatedAt: s.updatedAt,
      ...(s.lifecycle !== undefined ? { lifecycle: s.lifecycle } : {}),
    }
  })
  const res = await completeKnowledgeJson({
    system: CONTESTED_SYSTEM,
    user: buildContestedUser(inputs),
    schema: contestedResponseSchema,
    model,
    purpose: "contested sources",
  })
  if (res.isErr()) {
    console.warn(`ask: contested-sources check failed: ${res.error.message}`)
    return {}
  }
  const contested = toContestedFacts(res.value, inputs)
  return contested.length > 0 ? { contested } : {}
}

/**
 * Tier-B entailment judge: pairs each citation-bearing claim with its cited
 * snippet text and asks the chat model, in one batched call, whether each claim
 * is entailed by its own snippet. Best-effort — returns `{}` when the flag is
 * off, there are no cited claims, or the judge call fails, so the answer path
 * never breaks on it and the result spreads straight into the Answer.
 */
const tierBFaithfulness = async (
  props: AskProps,
  answerText: string,
  citations: readonly Citation[],
  model: LlmModel,
): Promise<{ semanticGroundedness?: number; contradictedClaims?: string[] }> => {
  if (props.faithfulnessTierB !== true) {
    return {}
  }
  const snippetByNumber = new Map(citations.map((c) => [c.number, c.snippet]))
  const claims: EntailmentClaim[] = supportedClaims(answerText, citations).map((c) => {
    return {
      claim: c.claim,
      snippets: c.citedNumbers
        .map((n) => snippetByNumber.get(n))
        .filter((s): s is string => s !== undefined && s !== ""),
    }
  })
  if (claims.length === 0) {
    return {}
  }
  const res = await completeKnowledgeJson({
    system: ENTAILMENT_SYSTEM,
    user: buildEntailmentUser(claims),
    schema: entailmentResponseSchema,
    model,
    purpose: "faithfulness entailment",
  })
  if (res.isErr()) {
    console.warn(`ask: tier-b entailment failed: ${res.error.message}`)
    return {}
  }
  return aggregateEntailment(claims, res.value.verdicts)
}

/** `runAsk` wrapped in an OpenInference CHAIN span (a no-op until an exporter is
 * registered). Captures the question, answer, model, served-by, citation count,
 * and the phase timings as span events — the why-trace, portable to any OTel
 * backend (Phoenix / Langfuse / LangSmith). */
const runAskTraced = async (props: AskProps): Promise<Answer> =>
  withSpan("knowledge.ask", SpanKind.CHAIN, async (span) => {
    // Root agent span: stamp the OTel GenAI agent attributes so any OTLP backend
    // attributes the whole ask/answer why-trace to this agent (invoke_agent).
    setAgentAttributes(span)
    setInput(span, props.question)
    const answer = await runAsk(props)
    setOutput(span, answer.answer)
    span.setAttribute(Attr.LLM_MODEL, answer.model)
    span.setAttribute(Attr.SERVED_BY, answer.servedBy)
    span.setAttribute(Attr.CITATION_COUNT, answer.citations.length)
    span.setAttribute(Attr.RETRIEVAL_MS, answer.retrievalMs)
    span.setAttribute(Attr.GENERATION_MS, answer.generationMs)
    span.setAttribute(Attr.GROUNDEDNESS, answer.groundedness ?? 1)
    span.setAttribute(Attr.UNSUPPORTED_CLAIM_COUNT, answer.unsupportedClaims?.length ?? 0)
    span.setAttribute(Attr.ABSTAINED, answer.abstained ?? false)
    for (const phase of answer.phases ?? []) {
      span.addEvent(`phase.${phase.phase}`, { ms: phase.ms })
    }
    return answer
  })

/** Runs the full /ask pipeline for one question. */
export const ask = (props: AskProps): ResultAsync<Answer, AskError> =>
  ResultAsync.fromPromise(runAskTraced(props), (e) =>
    e !== null && typeof e === "object" && "type" in e && (e as AskError).type === "ask_error"
      ? (e as AskError)
      : askError(e instanceof Error ? e.message : String(e)),
  ).andThen((answer) =>
    // Best-effort telemetry write — a failure must never degrade the answer.
    // The row id flows back as `telemetryId` so /ask feedback can link to it.
    recordAskTelemetry({
      tx: props.tx,
      event: {
        memberId: props.memberId ?? null,
        questionHash: hashQuestion(props.question),
        questionText: props.evalHarvest === true ? props.question : null,
        servedBy: answer.servedBy,
        status: answer.status ?? null,
        retrievalMs: answer.retrievalMs,
        generationMs: answer.generationMs,
        model: answer.model,
        citationCount: answer.citations.length,
        answerChars: answer.answer.length,
        rerankUsed: answer.rerankUsed ?? false,
        rerankLatencyMs: answer.rerankLatencyMs ?? null,
        graphContextRows: answer.graphContextRows ?? 0,
        phases: answer.phases ?? [],
      },
    })
      .map((row): Answer => {
        return { ...answer, telemetryId: row.id }
      })
      .orElse((telemetryError) => {
        console.warn("[Knowledge] ask telemetry write failed", telemetryError)
        return okAsync<Answer, AskError>(answer)
      }),
  )
