/**
 * MCP tool handlers. Framework-agnostic: each tool is a
 * { name, description, inputSchema, handle } record delegating to the retrieval
 * /ask/graph functions. The MCP transport (streamable HTTP) + JWT + revocation
 * mounting is an app-surface concern wired in Tier-3 with
 * @modelcontextprotocol/sdk; this module is the logic those tools run.
 */

import type { Transaction } from "@agenticmind/shared/database/client"
import type { KnowledgeHit } from "@agenticmind/shared/database/query/knowledge/chunks"
import type { LlmModel } from "@agenticmind/shared/lib/ai/model"
import type { AnswerPolicy } from "@agenticmind/shared/lib/knowledge/answer-policy"
import type { KnowledgeBlobStore } from "@agenticmind/shared/lib/knowledge/blobstore"
import type { GraphStore } from "@agenticmind/shared/lib/knowledge/graph-store"
import type { RetrievalParams } from "@agenticmind/shared/lib/knowledge/retrieval-params"
import type { CallerContext } from "@agenticmind/shared/lib/knowledge/synth"
import type { CorpusChunk } from "@agenticmind/shared/lib/skill/compile-live"

import {
  answerHitlRequest,
  createHitlRequest,
  getHitlRequest,
} from "@agenticmind/shared/database/query/hitl/requests"
import { recordEvent } from "@agenticmind/shared/database/query/knowledge/ask-feedback"
import {
  assertBelief,
  recallBeliefs,
  retractBelief,
} from "@agenticmind/shared/database/query/knowledge/beliefs"
import { searchChunks } from "@agenticmind/shared/database/query/knowledge/chunks"
import { recordGuardEvent } from "@agenticmind/shared/database/query/knowledge/guard-events"
import { getMaterial } from "@agenticmind/shared/database/query/knowledge/materials"
import { checkRateLimit } from "@agenticmind/shared/database/query/knowledge/rate-limits"
import {
  insertSkillVersion,
  upsertSkill,
} from "@agenticmind/shared/database/query/knowledge/skills"
import { SUPPORTED_LANGUAGES } from "@agenticmind/shared/database/schema/knowledge/_config"
import { ask } from "@agenticmind/shared/lib/knowledge/ask"
import { decayedConfidence, summarizeContested } from "@agenticmind/shared/lib/knowledge/belief"
import { approxTokens } from "@agenticmind/shared/lib/knowledge/chunker"
import { packByTokenBudget } from "@agenticmind/shared/lib/knowledge/context-budget"
import {
  defaultStrengthFor,
  isAgentSignal,
  isValidSignal,
} from "@agenticmind/shared/lib/knowledge/feedback"
import { guardInput, redactPii } from "@agenticmind/shared/lib/knowledge/guard"
import { ingestText } from "@agenticmind/shared/lib/knowledge/ingest"
import { removeMaterial } from "@agenticmind/shared/lib/knowledge/ingestion"
import { resolveJudgeModel } from "@agenticmind/shared/lib/knowledge/judge-model"
import { embedKnowledgeText } from "@agenticmind/shared/lib/knowledge/llm"
import { hasScope } from "@agenticmind/shared/lib/knowledge/mcp-scopes"
import { createGraphContextProvider } from "@agenticmind/shared/lib/knowledge/qaplan"
import { LIFECYCLES } from "@agenticmind/shared/lib/knowledge/source-trust"
import { compileSkillLive } from "@agenticmind/shared/lib/skill/compile-live"
import { aiSettings } from "@agenticmind/shared/settings/ai-settings"
import { createHash, randomUUID } from "node:crypto"
import * as z from "zod"

/** Per-request dependencies for the knowledge MCP tools. */
export type McpToolDeps = {
  tx: Transaction
  cardsEnabled?: boolean
  cacheEnabled?: boolean
  chatModel?: LlmModel
  memberContext?: CallerContext | null
  /** Optional GraphRAG store (Postgres flagship / Neo4j swap-in);
   * kl_graph_neighbors is omitted when absent. */
  graph?: GraphStore
  /** Capability scopes granted to the calling token (least-privilege).
   * Write tools (kl_signal, mem_write) assert their required scope against this. */
  scopes?: string[]
  /** The calling agent's principal id — owns private memory written via mem_write. */
  actorUuid?: string | null
  /** Blob store for ingested material bytes (kl_ingest). */
  blobStore?: KnowledgeBlobStore
  /** Active corpus-adaptive retrieval profile (Lever 3.2); unset = engine defaults. */
  retrievalParams?: RetrievalParams
  /** Run the Tier-B semantic-entailment faithfulness judge on kl_ask_global
   * (one extra LLM call). Default off; Tier-A signals are always computed. */
  faithfulnessTierB?: boolean
  /** Run the contested-sources judge on kl_ask_global (one extra LLM call).
   * Default off. Surfaces facts the retrieved sources disagree on. */
  contestedSources?: boolean
  /** Persist the raw question on telemetry so signalled queries feed the tuner.
   * Default off (privacy: hash-only). */
  evalHarvest?: boolean
  /** Active answer policy (KNOWLEDGE_ANSWER_POLICY); unset = no enforcement. */
  answerPolicy?: AnswerPolicy
  /** Run the acceptance evaluator on kl_ingest's extracted cards. Default off. */
  acceptanceEvaluator?: boolean
  /** Redact PII from kl_ask_global answers + citation snippets. Default on. */
  piiRedaction?: boolean
}

const snippet = (s: string, max = 240): string => {
  const runes = Array.from(s)
  return runes.length <= max ? s : `${runes.slice(0, max).join("")}…`
}

const resolveTitle = async (
  tx: Transaction,
  materialId: string,
  cache: Map<string, string>,
): Promise<string> => {
  const cached = cache.get(materialId)
  if (cached !== undefined) {
    return cached
  }
  const res = await getMaterial({ tx, id: materialId })
  const title = res.isOk() && res.value !== null ? res.value.title : ""
  cache.set(materialId, title)
  return title
}

const GUARD_RATE_LIMIT = 60
const GUARD_RATE_WINDOW_SEC = 60
const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex")

/** Rate-limit + injection gate; records a hashed guard_event on block. */
const enforceGuards = async (deps: McpToolDeps, tool: string, text: string): Promise<void> => {
  const actorUuid = deps.actorUuid ?? null
  if (actorUuid !== null) {
    const rl = await checkRateLimit({
      tx: deps.tx,
      key: actorUuid,
      limit: GUARD_RATE_LIMIT,
      windowSeconds: GUARD_RATE_WINDOW_SEC,
    })
    if (rl.isOk() && !rl.value.allowed) {
      await recordGuardEvent({
        tx: deps.tx,
        event: { actorUuid, tool, reason: "rate_limited" },
      }).unwrapOr([])
      throw new Error(`${tool}: rate limit exceeded`)
    }
  }
  const g = guardInput(text)
  if (!g.ok) {
    const reason = g.tags.includes("injection") ? "injection" : "too_long"
    await recordGuardEvent({
      tx: deps.tx,
      event: { actorUuid, tool, reason, inputHash: sha256hex(text) },
    }).unwrapOr([])
    throw new Error(`${tool} blocked: ${g.reason}`)
  }
}

export const klSearchInput = z.object({
  q: z.string().min(1),
  /** Extra sub-queries fanned out in one round-trip; results merged + deduped. */
  queries: z.array(z.string().min(1)).max(8).optional(),
  limit: z.number().int().positive().max(50).optional(),
  /** Return the best ~N tokens of context instead of a fixed count of passages. */
  tokenBudget: z.number().int().positive().max(32_000).optional(),
})

/** Fan out sub-queries concurrently, merge hits by chunk (keep the best score). */
const searchMerged = async (
  deps: McpToolDeps,
  queries: string[],
  limit: number,
): Promise<KnowledgeHit[]> => {
  const perQuery = await Promise.all(
    queries.map(async (query): Promise<KnowledgeHit[]> => {
      const e = await embedKnowledgeText(query)
      if (e.isErr()) {
        throw new Error(`kl_search: embed: ${e.error.message}`)
      }
      const h = await searchChunks({ tx: deps.tx, queryEmbedding: e.value, limit })
      if (h.isErr()) {
        throw new Error(`kl_search: ${h.error.message}`)
      }
      return h.value
    }),
  )
  const byChunk = new Map<string, KnowledgeHit>()
  for (const hits of perQuery) {
    for (const h of hits) {
      const existing = byChunk.get(h.chunkId)
      if (existing === undefined || h.score > existing.score) {
        byChunk.set(h.chunkId, h)
      }
    }
  }
  return [...byChunk.values()].toSorted((a, b) => b.score - a.score)
}

/**
 * Kl_search — vector retrieval over the chunks index. Accepts a batch of
 * sub-queries (`queries`) fanned out in one round-trip, and an optional
 * `tokenBudget` to return the best ~N tokens of context instead of a fixed count.
 */
export const klSearch = async (
  deps: McpToolDeps,
  args: z.infer<typeof klSearchInput>,
): Promise<{
  query: string
  hits: { materialId: string; title: string; snippet: string; score: number }[]
}> => {
  const queries = [...new Set([args.q, ...(args.queries ?? [])].map((s) => s.trim()))].filter(
    (s) => s.length > 0,
  )
  for (const query of queries) {
    await enforceGuards(deps, "kl_search", query)
  }
  const limit = args.limit !== undefined && args.limit > 0 && args.limit <= 50 ? args.limit : 10

  const ranked = await searchMerged(deps, queries, limit)
  const selected =
    args.tokenBudget !== undefined
      ? packByTokenBudget(ranked, args.tokenBudget, (h) => approxTokens(h.body))
      : ranked.slice(0, limit)

  const titles = new Map<string, string>()
  const out = []
  for (const h of selected) {
    out.push({
      materialId: h.materialId,
      title: await resolveTitle(deps.tx, h.materialId, titles),
      snippet: snippet(h.body),
      score: h.score,
    })
  }
  return { query: args.q, hits: out }
}

export const klAskGlobalInput = z.object({
  question: z.string().min(1),
  /** The calling agent's goal — synthesised answers are tailored to it. */
  intent: z.string().max(500).optional(),
  /** Arbitrary caller facts the answer should account for. */
  facts: z
    .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
    .max(20)
    .optional(),
})

/** Kl_ask_global — RAG synthesis with citations (reuses the ask pipeline). */
export const klAskGlobal = async (deps: McpToolDeps, args: z.infer<typeof klAskGlobalInput>) => {
  await enforceGuards(deps, "kl_ask_global", args.question)
  // Caller context: host-supplied context merged with the agent's per-call
  // Intent/facts. Empty → the synth falls back to the bare system prompt.
  const callerContext: CallerContext = {
    kind: "agent",
    ...deps.memberContext,
    ...(args.intent !== undefined ? { intent: args.intent } : {}),
    ...(args.facts !== undefined ? { facts: args.facts } : {}),
  }
  const answer = await ask({
    tx: deps.tx,
    question: args.question,
    memberContext: callerContext,
    cardsEnabled: deps.cardsEnabled,
    cacheEnabled: deps.cacheEnabled,
    chatModel: deps.chatModel,
    // Corpus-adaptive retrieval profile (Lever 3.2); each field falls back to the
    // engine default when the profile is unset or omits it.
    hybridWeights: deps.retrievalParams?.hybridWeights,
    recencyConfig: deps.retrievalParams?.recencyConfig,
    topK: deps.retrievalParams?.topK,
    rerankTopN: deps.retrievalParams?.rerankTopN,
    faithfulnessTierB: deps.faithfulnessTierB,
    contestedSources: deps.contestedSources,
    evalHarvest: deps.evalHarvest,
    answerPolicy: deps.answerPolicy,
    piiRedaction: deps.piiRedaction,
    // Tier-2: wire qaplan's multi-hop graph traversal as the graph-context
    // Provider when a graph store is configured.
    graphContext:
      deps.graph !== undefined
        ? createGraphContextProvider({ repo: deps.graph, chatModel: deps.chatModel })
        : undefined,
  })
  if (answer.isErr()) {
    throw new Error(`kl_ask_global: ${answer.error.message}`)
  }
  return answer.value
}

export const klGetMaterialInput = z.object({ id: z.string().min(1) })

/** Kl_get_material — fetch a single material's metadata by id. */
export const klGetMaterial = async (
  deps: McpToolDeps,
  args: z.infer<typeof klGetMaterialInput>,
) => {
  const res = await getMaterial({ tx: deps.tx, id: args.id })
  if (res.isErr()) {
    throw new Error(`kl_get_material: ${res.error.message}`)
  }
  if (res.value === null) {
    throw new Error("kl_get_material: not found")
  }
  return res.value
}

export const klGraphNeighborsInput = z.object({
  materialId: z.string().min(1),
  limit: z.number().int().positive().max(50).optional(),
})

/** Kl_graph_neighbors — materials sharing a graph entity with the seed. */
export const klGraphNeighbors = async (
  deps: McpToolDeps,
  args: z.infer<typeof klGraphNeighborsInput>,
): Promise<{
  seed: string
  neighbors: {
    materialId: string
    title: string
    entityName: string
    entityType: string
    distance: number
  }[]
}> => {
  if (deps.graph === undefined) {
    throw new Error("kl_graph_neighbors disabled: graphrag not configured")
  }
  const limit = args.limit !== undefined && args.limit > 0 && args.limit <= 50 ? args.limit : 10
  const result = await deps.graph.neighbors(args.materialId, limit)
  if (result.isErr()) {
    throw new Error(`kl_graph_neighbors: ${result.error.message}`)
  }
  const titles = new Map<string, string>()
  const neighbors = []
  for (const n of result.value) {
    neighbors.push({
      materialId: n.materialId,
      title: await resolveTitle(deps.tx, n.materialId, titles),
      entityName: n.entity.canonicalName,
      entityType: n.entity.type,
      distance: n.distance,
    })
  }
  return { seed: args.materialId, neighbors }
}

export const klSignalInput = z.object({
  /** The `telemetryId` returned by kl_ask_global for the answer being judged. */
  askId: z.string().min(1),
  /** A programmatic signal: verified_supported | verification_failed | eval_passed |
   * eval_failed | downstream_success | downstream_failure | used_in_generation. */
  signal: z.string().min(1),
  /** Optional override in [-1, 1]; defaults to the signal's canonical strength. */
  strength: z.number().min(-1).max(1).optional(),
  /** Optional free-text note stored on the event (e.g. the failing eval case). */
  note: z.string().max(500).optional(),
})

/**
 * Kl_signal — an agent / eval / verifier emits a programmatic feedback signal
 * on a prior answer. This is what makes the compounding loop self-improve
 * without a human: signals feed the same clustering → judge → resolution-card
 * promotion path that human thumbs do. Only agent signals are accepted here.
 */
export const klSignal = async (
  deps: McpToolDeps,
  args: z.infer<typeof klSignalInput>,
): Promise<{ ok: true; askId: string; signal: string; strength: number }> => {
  if (!hasScope(deps.scopes, "knowledge:signal")) {
    throw new Error("kl_signal: missing required scope 'knowledge:signal'")
  }
  if (!isValidSignal(args.signal)) {
    throw new Error(`kl_signal: unknown signal '${args.signal}'`)
  }
  if (!isAgentSignal(args.signal)) {
    throw new Error(`kl_signal: '${args.signal}' is not an agent signal`)
  }
  const strength = args.strength ?? defaultStrengthFor(args.signal)
  const res = await recordEvent({
    tx: deps.tx,
    event: {
      askId: args.askId,
      memberId: null,
      signal: args.signal,
      strength,
      source: "agent",
      metadata: args.note !== undefined && args.note !== "" ? { note: args.note } : {},
    },
  })
  if (res.isErr()) {
    throw new Error(`kl_signal: ${res.error.message}`)
  }
  return { ok: true, askId: args.askId, signal: args.signal, strength }
}

export const memWriteInput = z.object({
  /** What the belief is about (entity / topic). */
  subject: z.string().min(1).max(200),
  /** The relation / attribute. */
  predicate: z.string().min(1).max(100),
  /** The claimed value. */
  object: z.string().min(1).max(2000),
  /** 0..1; how sure the agent is. Defaults to 0.6. */
  confidence: z.number().min(0).max(1).optional(),
  /** Compute an embedding so the belief is semantically recallable (default true). */
  embed: z.boolean().optional(),
})

/**
 * Mem_write — the calling agent records a belief into its PRIVATE memory.
 * Belief-revision-aware: a contradicting claim on the same (subject,predicate)
 * supersedes the old one non-destructively (the history stays replayable).
 * Corroborated private beliefs are later consolidated into shared memory by the
 * worker sweep. Requires the memory:write scope.
 */
export const memWrite = async (
  deps: McpToolDeps,
  args: z.infer<typeof memWriteInput>,
): Promise<{ id: string; revised: boolean }> => {
  if (!hasScope(deps.scopes, "memory:write")) {
    throw new Error("mem_write: missing required scope 'memory:write'")
  }
  const actorUuid = deps.actorUuid ?? null
  if (actorUuid === null) {
    throw new Error("mem_write: no agent identity on the token")
  }

  await enforceGuards(deps, "mem_write", `${args.subject} ${args.predicate} ${args.object}`)
  const redactRes = redactPii(args.object)
  const object = redactRes.redacted
  if (redactRes.found.length > 0) {
    await recordGuardEvent({
      tx: deps.tx,
      event: {
        actorUuid: deps.actorUuid ?? null,
        tool: "mem_write",
        reason: "pii_redacted",
        inputHash: sha256hex(args.object),
      },
    }).unwrapOr([])
  }

  let embedding: number[] | null = null
  if (args.embed !== false) {
    const e = await embedKnowledgeText(`${args.subject} ${args.predicate} ${args.object}`)
    if (e.isOk()) {
      embedding = e.value
    }
  }

  const res = await assertBelief({
    tx: deps.tx,
    belief: {
      actorUuid,
      subject: args.subject,
      predicate: args.predicate,
      object,
      confidence: args.confidence ?? 0.6,
      sourceKind: "agent",
      sourceId: actorUuid,
      embedding,
    },
  })
  if (res.isErr()) {
    throw new Error(`mem_write: ${res.error.message}`)
  }
  return { id: res.value.id, revised: res.value.supersedes !== null }
}

export const memForgetInput = z.object({ id: z.uuid() })

/**
 * Mem_forget — retract one of your OWN beliefs by id. Soft + bitemporal: the
 * belief drops from current memory but stays recallable via `asOf` for audit
 * (the memory counterpart of kl_forget). Requires the elevated memory:admin scope.
 */
export const memForget = async (deps: McpToolDeps, args: z.infer<typeof memForgetInput>) => {
  if (!hasScope(deps.scopes, "memory:admin")) {
    throw new Error("mem_forget: missing required scope 'memory:admin'")
  }
  const actorUuid = deps.actorUuid ?? null
  if (actorUuid === null) {
    throw new Error("mem_forget: no agent identity on the token")
  }
  const res = await retractBelief({ tx: deps.tx, actorUuid, id: args.id })
  if (res.isErr()) {
    throw new Error(`mem_forget: ${res.error.message}`)
  }
  return { id: args.id, retracted: res.value.retracted }
}

export const memRecallInput = z.object({
  /** Exact subject filter (optional). */
  subject: z.string().max(200).optional(),
  /** Semantic query — recall the most relevant beliefs (optional). */
  query: z.string().max(500).optional(),
  /** Time-travel: what was believed at this ISO instant (transaction time). */
  asOf: z.iso.datetime().optional(),
  /** Include shared/collective beliefs alongside the agent's own (default true). */
  includeShared: z.boolean().optional(),
  limit: z.number().int().positive().max(50).optional(),
})

/**
 * Mem_recall — recall the calling agent's beliefs, optionally unioned with the
 * shared/collective memory, by subject or semantic similarity, optionally as of
 * a past instant (belief time-travel). Requires the memory:read scope.
 */
export const memRecall = async (deps: McpToolDeps, args: z.infer<typeof memRecallInput>) => {
  if (!hasScope(deps.scopes, "memory:read")) {
    throw new Error("mem_recall: missing required scope 'memory:read'")
  }

  let queryEmbedding: number[] | undefined
  if (args.query !== undefined && args.query !== "") {
    const e = await embedKnowledgeText(args.query)
    if (e.isOk()) {
      queryEmbedding = e.value
    }
  }

  const res = await recallBeliefs({
    tx: deps.tx,
    actorUuid: deps.actorUuid ?? null,
    includeShared: args.includeShared ?? true,
    subject: args.subject,
    queryEmbedding,
    asOf: args.asOf !== undefined ? new Date(args.asOf) : undefined,
    limit: args.limit,
  })
  if (res.isErr()) {
    throw new Error(`mem_recall: ${res.error.message}`)
  }
  // Time-decay: surface an age-adjusted `effectiveConfidence` per belief so the
  // caller can down-weight stale facts. Recency is trust; re-assertion resets it.
  const now = Date.now()
  const beliefs = res.value.map((b) => {
    return { ...b, effectiveConfidence: decayedConfidence(b.confidence, b.recordedAt, now) }
  })
  // Surface conflicts instead of silently resolving them: which recalled beliefs
  // are contested (same subject+predicate, different objects), each variant
  // tagged with its source actor + date so the agent can judge for itself.
  const contested = summarizeContested(
    res.value.map((b) => {
      return {
        actorUuid: b.actorUuid,
        subject: b.subject,
        predicate: b.predicate,
        object: b.object,
        confidence: b.confidence,
        recordedAt: b.recordedAt ?? undefined,
      }
    }),
  )
  return { beliefs, contested }
}

export const klIngestInput = z.object({
  title: z.string().min(1).max(300),
  text: z.string().min(1).max(200_000),
  language: z.enum(SUPPORTED_LANGUAGES).optional(),
  /** Content lifecycle (default active) — set superseded/deprecated/archived for
   * older revisions so retrieval down-weights them. */
  lifecycle: z.enum(LIFECYCLES).optional(),
  /** Source trust tier (higher wins on conflict; default 0). */
  trustTier: z.number().int().min(0).max(100).optional(),
})

/**
 * Kl_ingest -- push text into the knowledge base (chunk + embed + cards +
 * graph). Requires knowledge:write. Later kl_ask_global / kl_search can cite it.
 */
export const klIngest = async (deps: McpToolDeps, args: z.infer<typeof klIngestInput>) => {
  if (!hasScope(deps.scopes, "knowledge:write")) {
    throw new Error("kl_ingest: missing required scope 'knowledge:write'")
  }
  await enforceGuards(deps, "kl_ingest", `${args.title} ${args.text.slice(0, 2000)}`)
  if (deps.blobStore === undefined) {
    throw new Error("kl_ingest: blob store not configured")
  }
  const res = await ingestText({
    tx: deps.tx,
    blobStore: deps.blobStore,
    graph: deps.graph,
    title: args.title,
    text: args.text,
    cardsEnabled: deps.cardsEnabled,
    acceptanceEvaluator: deps.acceptanceEvaluator,
    graphragEnabled: deps.graph !== undefined,
    language: args.language,
    lifecycle: args.lifecycle,
    trustTier: args.trustTier,
  })
  if (res.isErr()) {
    throw new Error(`kl_ingest: ${res.error.message}`)
  }
  return res.value
}

export const klCompileSkillInput = z.object({
  /** The behaviour to encode, e.g. "deploy-strands-safely". */
  target: z.string().min(1).max(200),
  name: z.string().min(1).max(200).optional(),
  /** Retrieval query for the corpus slice; defaults to `target`. */
  query: z.string().min(1).optional(),
  limit: z.number().int().positive().max(50).optional(),
  /** Semver for this compile; defaults to 1.0.0. */
  version: z.string().min(1).optional(),
})

/** Convention version of the extraction prompt — bump on prompt changes (reproducibility). */
const SKILL_EXTRACT_CONVENTION = "skill-extract-v1"

/**
 * Kl_compile_skill (§4) — compile a reusable, cited SKILL.md for `target` from the corpus:
 * retrieve → temperature-0 extract → L1 structural gate → decorrelated L2 faithfulness gate
 * → persist (skill + versioned row). Fail-closed at every gate; the L2 judge must be a
 * different model family than the extractor, so an unset CHAT_JUDGE_MODEL fails closed
 * rather than judging with the same mind. Requires knowledge:write.
 */
export const klCompileSkill = async (
  deps: McpToolDeps,
  args: z.infer<typeof klCompileSkillInput>,
) => {
  if (!hasScope(deps.scopes, "knowledge:write")) {
    throw new Error("kl_compile_skill: missing required scope 'knowledge:write'")
  }
  const query = (args.query ?? args.target).trim()
  await enforceGuards(deps, "kl_compile_skill", query)
  const limit = args.limit !== undefined && args.limit > 0 && args.limit <= 50 ? args.limit : 12

  const hits = await searchMerged(deps, [query], limit)
  if (hits.length === 0) {
    return {
      ok: false as const,
      errors: ["no corpus retrieved for the target — ingest sources first"],
    }
  }
  const titles = new Map<string, string>()
  const chunks: CorpusChunk[] = []
  for (const h of hits) {
    chunks.push({
      body: h.body,
      materialId: h.materialId,
      chunk: h.chunkId,
      title: await resolveTitle(deps.tx, h.materialId, titles),
    })
  }

  const extractorModel = aiSettings.CHAT_MODEL_COMPLEX
  const judgeModel = resolveJudgeModel(extractorModel, aiSettings.CHAT_JUDGE_MODEL)
  const name = args.name ?? args.target
  const result = await compileSkillLive({
    name,
    target: args.target,
    version: args.version ?? "1.0.0",
    extractorModel,
    extractorVersion: SKILL_EXTRACT_CONVENTION,
    judgeModel,
    chunks,
  })
  if (!result.ok) {
    return { ok: false as const, errors: result.errors }
  }

  const skillId = await upsertSkill({ tx: deps.tx, target: args.target, name })
  if (skillId.isErr()) {
    throw new Error(`kl_compile_skill: ${skillId.error.message}`)
  }
  const fm = result.skill.frontmatter
  const versionId = await insertSkillVersion({
    tx: deps.tx,
    input: {
      skillId: skillId.value,
      version: fm.version,
      corpusSnapshotId: result.corpusSnapshotId,
      extractorModel: fm.extractorModel,
      extractorVersion: fm.extractorVersion,
      judgeModel,
      judgeVersionHash: result.judgeVersionHash,
      evalPassRate: result.report.evalPassRate,
      passed: result.report.passed,
      md: result.md,
      citations: result.skill.citations,
      contradicted: result.report.contradicted,
      completenessScore: result.completeness.completenessScore,
      missed: result.completeness.missed,
      compiledAt: fm.compiledAt !== undefined ? new Date(fm.compiledAt) : new Date(),
    },
  })
  if (versionId.isErr()) {
    throw new Error(`kl_compile_skill: ${versionId.error.message}`)
  }

  return {
    ok: true as const,
    skillId: skillId.value,
    versionId: versionId.value,
    target: args.target,
    corpusSnapshotId: result.corpusSnapshotId,
    evalPassRate: result.report.evalPassRate,
    completenessScore: result.completeness.completenessScore,
    missed: result.completeness.missed.length,
    directives: result.skill.directives.length,
    negatives: result.skill.negatives.length,
    citations: result.skill.citations.length,
    md: result.md,
  }
}

export const klForgetInput = z.object({ id: z.string().min(1) })

/**
 * Kl_forget -- the inverse of kl_ingest: permanently delete a material by its
 * UUID and everything derived from it (chunks, embeddings, fact cards, graph
 * mentions; best-effort blob cleanup). For retraction / right-to-erasure.
 * Requires the elevated knowledge:admin scope. Idempotent — removed=false when
 * the id does not exist.
 */
export const klForget = async (deps: McpToolDeps, args: z.infer<typeof klForgetInput>) => {
  if (!hasScope(deps.scopes, "knowledge:admin")) {
    throw new Error("kl_forget: missing required scope 'knowledge:admin'")
  }
  if (deps.blobStore === undefined) {
    throw new Error("kl_forget: blob store not configured")
  }
  const res = await removeMaterial({ tx: deps.tx, blobStore: deps.blobStore, id: args.id })
  if (res.isErr()) {
    throw new Error(`kl_forget: ${res.error.message}`)
  }
  return { id: args.id, ...res.value }
}

export const hitlRequestInput = z.object({
  /** The question / decision to put to a human. Free text — guarded for injection + length. */
  question: z.string().min(1).max(2000),
  /** What kind of decision this is (drives routing/rendering). Defaults to "clarification". */
  kind: z.string().min(1).max(64).optional(),
  /** Idempotency key (e.g. the originating tool-call id): a retry with the same key returns the
   * existing pending request instead of creating a duplicate. Generated if omitted. */
  requestId: z.string().min(1).max(200).optional(),
  /** Structured context stored with the question (e.g. the proposed action to approve). */
  context: z.record(z.string(), z.unknown()).optional(),
  /** Optional deadline in seconds; a pending request past it is expired and escalated. */
  expiresInSeconds: z.number().int().positive().max(2_592_000).optional(),
})

/**
 * Hitl_request — the agent EMITS a request for a human decision and the loop SUSPENDS on it
 * (12-Factor F7 / STANDARD Layer 5 durable-HITL invariant). Returns IMMEDIATELY with
 * `{ id, status: "pending" }`: it does NOT block for the answer (the MCP call is capped at 60s and
 * a human may take days). The durable row survives a killed process; the human later answers via
 * hitl_respond, and this agent resumes by polling hitl_get for the answer. Requires the hitl:request scope.
 */
export const hitlRequest = async (
  deps: McpToolDeps,
  args: z.infer<typeof hitlRequestInput>,
): Promise<{ id: string; requestId: string; status: "pending" }> => {
  if (!hasScope(deps.scopes, "hitl:request")) {
    throw new Error("hitl_request: missing required scope 'hitl:request'")
  }
  const actorUuid = deps.actorUuid ?? null
  if (actorUuid === null) {
    throw new Error("hitl_request: no agent identity on the token")
  }
  // `internal:` kinds are reserved for internal worker consumers (e.g. remediation approvals); an
  // agent must not be able to forge one via this tool and have the resume sweep pick it up.
  if (args.kind !== undefined && args.kind.startsWith("internal:")) {
    throw new Error("hitl_request: 'internal:' kinds are reserved for internal consumers")
  }
  await enforceGuards(deps, "hitl_request", args.question)
  const requestId = args.requestId ?? randomUUID()
  const expiresAt =
    args.expiresInSeconds !== undefined
      ? new Date(Date.now() + args.expiresInSeconds * 1000)
      : undefined
  const res = await createHitlRequest({
    tx: deps.tx,
    request: {
      requestId,
      kind: args.kind ?? "clarification",
      requestedBy: actorUuid,
      payload: { question: args.question, context: args.context ?? {} },
      expiresAt,
    },
  })
  if (res.isErr()) {
    throw new Error(`hitl_request: ${res.error.message}`)
  }
  return { id: res.value, requestId, status: "pending" }
}

export const hitlRespondInput = z.object({
  /** The pending request id returned by hitl_request. */
  id: z.uuid(),
  /** The human's answer / decision, delivered back to the paused loop. */
  answer: z.string().min(1).max(4000),
})

/**
 * Hitl_respond — a HUMAN delivers the answer to a pending hitl_request, flipping it
 * pending→answered so a worker can resume the paused loop. Gated on the elevated hitl:respond
 * scope, held by human-facing tokens only — an agent's own token must NOT carry it, or an agent
 * could answer its own request and defeat the human gate (Cycle of Trust).
 */
export const hitlRespond = async (
  deps: McpToolDeps,
  args: z.infer<typeof hitlRespondInput>,
): Promise<{ id: string; status: "answered" }> => {
  if (!hasScope(deps.scopes, "hitl:respond")) {
    throw new Error("hitl_respond: missing required scope 'hitl:respond'")
  }
  const answeredBy = deps.actorUuid ?? null
  if (answeredBy === null) {
    throw new Error("hitl_respond: no principal identity on the token")
  }
  const res = await answerHitlRequest({
    tx: deps.tx,
    id: args.id,
    answeredBy,
    response: { answer: args.answer },
  })
  if (res.isErr()) {
    throw new Error(`hitl_respond: ${res.error.message}`)
  }
  if (res.value.length === 0) {
    throw new Error("hitl_respond: request not found or no longer pending")
  }
  return { id: args.id, status: "answered" }
}

export const hitlGetInput = z.object({
  /** The pending request id returned by hitl_request. */
  id: z.uuid(),
})

/**
 * Hitl_get — the asking agent polls its OWN request to read the human's answer and resume (12-Factor
 * F6 pause/resume: the loop suspended on hitl_request continues once this returns status "answered").
 * Authorized to the requester only — a request created by a different actor reads as not-found.
 * Requires the hitl:request scope.
 */
export const hitlGet = async (
  deps: McpToolDeps,
  args: z.infer<typeof hitlGetInput>,
): Promise<{ id: string; status: string; response: unknown; expiresAt: string | null }> => {
  if (!hasScope(deps.scopes, "hitl:request")) {
    throw new Error("hitl_get: missing required scope 'hitl:request'")
  }
  const actorUuid = deps.actorUuid ?? null
  if (actorUuid === null) {
    throw new Error("hitl_get: no agent identity on the token")
  }
  const res = await getHitlRequest({ tx: deps.tx, id: args.id })
  if (res.isErr()) {
    throw new Error(`hitl_get: ${res.error.message}`)
  }
  const row = res.value
  if (row === null || row.requestedBy !== actorUuid) {
    // Don't reveal another actor's request, even by its existence.
    throw new Error("hitl_get: request not found")
  }
  return {
    id: row.id,
    status: row.status,
    response: row.response,
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
  }
}

/**
 * SemVer of the public MCP tool contract (names + input schemas + scopes), as
 * surfaced in `serverInfo.version`. Bump MINOR for additive changes (a new tool,
 * a new optional field), MAJOR for breaking ones (removed/renamed tool or field,
 * a newly-required field). The contract snapshot test (mcp-contract.test.ts)
 * guards against silent drift. See CONTRACT.md for the policy.
 */
export const MCP_CONTRACT_VERSION = "1.10.0"

/** Tool metadata (name + description + input schema) for MCP registration. */
export const KNOWLEDGE_MCP_TOOLS = [
  {
    name: "kl_search",
    description:
      "Search the knowledge base by keyword/semantic similarity. Returns matching passages with material titles and similarity scores. Pass `queries` (a batch of sub-questions) to retrieve for several angles in one round-trip — results are merged and deduped. Pass `tokenBudget` to get the best ~N tokens of context instead of a fixed count (agents on a context budget). Prefer for exploratory lookups; use kl_ask_global for a synthesised answer with citations.",
    inputSchema: klSearchInput,
  },
  {
    name: "kl_ask_global",
    description:
      "Ask a natural-language question about the knowledge base. Retrieves the most relevant passages, synthesises an answer, and returns citation markers ([1], [2], …) keyed to source materials.",
    inputSchema: klAskGlobalInput,
  },
  {
    name: "kl_get_material",
    description: "Fetch metadata for a single material by its UUID.",
    inputSchema: klGetMaterialInput,
  },
  {
    name: "kl_graph_neighbors",
    description:
      "Find materials related to a given material via the knowledge graph (sharing an extracted entity). Use for 'show me related content' after kl_search/kl_ask_global.",
    inputSchema: klGraphNeighborsInput,
  },
  {
    name: "kl_signal",
    description:
      "Emit a programmatic feedback signal on a prior answer (use the askId/telemetryId from kl_ask_global). Signals: verified_supported, verification_failed, eval_passed, eval_failed, downstream_success, downstream_failure, used_in_generation. This is how an agent or eval makes the knowledge base self-improve — strong signals promote the answer into a reusable resolution card.",
    inputSchema: klSignalInput,
  },
  {
    name: "mem_recall",
    description:
      "Recall your beliefs (subject-predicate-object facts) — your own private memory unioned with the shared/collective memory. Filter by subject or semantic query; pass `asOf` (ISO time) to time-travel to what was believed then. Each belief carries `effectiveConfidence`: its stored confidence after time-decay (a belief not re-asserted loses weight as it ages) — prefer it over raw `confidence` when deciding how much to trust a fact. Also returns `contested`: any recalled fact where sources disagree (same subject+predicate, different objects), each variant tagged with its source and date — so you can flag a disputed fact instead of trusting one side.",
    inputSchema: memRecallInput,
  },
  {
    name: "mem_write",
    description:
      "Record a belief into your private memory (subject, predicate, object, confidence). Belief-revision-aware: a contradicting claim supersedes the old one non-destructively. Corroborated beliefs consolidate into shared memory over time.",
    inputSchema: memWriteInput,
  },
  {
    name: "mem_forget",
    description:
      "Retract one of your own beliefs by id. Soft + bitemporal: it drops from current memory but stays recallable via mem_recall `asOf` for audit. The memory counterpart of kl_forget. Requires the elevated memory:admin scope.",
    inputSchema: memForgetInput,
  },
  {
    name: "kl_ingest",
    description:
      "Add text to the knowledge base (chunked, embedded, distilled into fact cards, graph-extracted). Requires knowledge:write. Later kl_ask_global / kl_search retrieve and cite it.",
    inputSchema: klIngestInput,
  },
  {
    name: "kl_compile_skill",
    description:
      "Compile a reusable, fully-cited SKILL.md for a target behaviour from the knowledge base — retrieve, extract cited directives + negatives, then fail-closed on a structural gate AND a decorrelated L2 faithfulness judge before persisting a versioned skill. Requires knowledge:write and a distinct CHAT_JUDGE_MODEL (a different family than the extractor).",
    inputSchema: klCompileSkillInput,
  },
  {
    name: "kl_forget",
    description:
      "Forget (permanently delete) a single material by its UUID and everything derived from it — chunks, embeddings, fact cards, and graph mentions. The inverse of kl_ingest, for retraction or right-to-erasure. Requires the elevated knowledge:admin scope.",
    inputSchema: klForgetInput,
  },
  {
    name: "hitl_request",
    description:
      "Ask a human for a decision and SUSPEND the loop on it — human-in-the-loop modeled as a tool call the agent emits (12-Factor F7). Returns immediately with { id, status: 'pending' }; it does NOT block for the answer, and the durable request survives both a long wait and a killed process. The human later answers via hitl_respond and a worker resumes the paused consumer. Pass requestId for idempotency and expiresInSeconds for a deadline (a stale request is expired and escalated). Requires the hitl:request scope.",
    inputSchema: hitlRequestInput,
  },
  {
    name: "hitl_respond",
    description:
      "Deliver a human's answer to a pending hitl_request by id, flipping it to answered so the paused loop can resume. Requires the elevated hitl:respond scope — a human-facing token, never the requesting agent's own token (or an agent could answer itself).",
    inputSchema: hitlRespondInput,
  },
  {
    name: "hitl_get",
    description:
      "Poll your own pending hitl_request by id to read the human's answer and resume (12-Factor F6). Returns { id, status, response, expiresAt }: status is 'pending' until a human answers via hitl_respond, then 'answered' with the response (or 'expired' if the deadline passed). Authorized to the requester only. Requires the hitl:request scope.",
    inputSchema: hitlGetInput,
  },
] as const
