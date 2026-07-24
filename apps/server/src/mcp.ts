/**
 * MCP streamable-HTTP handler — exposes the knowledge layer to external MCP
 * clients (Claude Desktop, Cursor, agents). Framework-agnostic: `mcp-handler`
 * produces a fetch handler `(Request) => Promise<Response>`, hosted by Bun in
 * index.ts. No Next.js — this is a headless service.
 *
 * Auth (withMcpAuth → verifyMcpAccess): the bearer must be a valid typ="mcp"
 * JWT (HS256 / AUTH_SECRET) whose jti is active in mcp_tokens. Fails CLOSED.
 * Per-token scopes drive least-privilege: read tools need knowledge:read
 * (endpoint-level), kl_signal needs knowledge:signal (enforced in the tool).
 */

import type { McpToolDeps } from "@agenticmind/shared/lib/knowledge/mcp-tools"
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { z } from "zod"

import { withTenant } from "@agenticmind/shared/database/client"
import { checkMcpToken } from "@agenticmind/shared/database/query/knowledge/mcp-tokens"
import { DEFAULT_TENANT_ID } from "@agenticmind/shared/database/schema/knowledge/_tenant"
import { AUDIT_WRITE_SCOPE } from "@agenticmind/shared/lib/audit/hook-event"
import { parseAnswerPolicy } from "@agenticmind/shared/lib/knowledge/answer-policy"
import {
  klAskGlobal,
  klAskGlobalInput,
  klGetMaterial,
  klGetMaterialInput,
  klGraphNeighbors,
  klGraphNeighborsInput,
  klSearch,
  klSearchInput,
  klSignal,
  klSignalInput,
  memForget,
  memForgetInput,
  memRecall,
  memRecallInput,
  memWrite,
  memWriteInput,
  klIngest,
  klIngestInput,
  klCompileSkill,
  klCompileSkillInput,
  klForget,
  klForgetInput,
  hitlGet,
  hitlGetInput,
  hitlRequest,
  hitlRequestInput,
  hitlRespond,
  hitlRespondInput,
  MCP_CONTRACT_VERSION,
} from "@agenticmind/shared/lib/knowledge/mcp-tools"
import { resolveRetrievalParams } from "@agenticmind/shared/lib/knowledge/retrieval-params"
import { knowledgeFeatureSettings } from "@agenticmind/shared/settings/knowledge-feature-settings"
import { mcpSettings } from "@agenticmind/shared/settings/mcp-settings"
import { createMcpHandler, withMcpAuth } from "mcp-handler"
import { timingSafeEqual } from "node:crypto"

import { getDb } from "@/server/lib/database"
import {
  getKnowledgeBlobStore,
  getKnowledgeGraphRepo,
  knowledgeFeatureFlags,
} from "@/server/lib/knowledge-deps"
import { verifyMcpToken } from "@/server/lib/mcp-jwt"

type ToolResult = {
  content: { type: "text"; text: string }[]
  isError?: boolean
}

const jsonContent = (value: unknown): ToolResult => {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  }
}

const errorContent = (message: string): ToolResult => {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  }
}

type ToolExtra = {
  authInfo?: { scopes?: string[]; clientId?: string; extra?: { tenantId?: string } }
}

// The active corpus-adaptive retrieval profile (Lever 3.2), resolved once at
// boot from RETRIEVAL_PARAMS. Unset / malformed ⇒ undefined ⇒ engine defaults.
const ACTIVE_RETRIEVAL_PARAMS = resolveRetrievalParams(knowledgeFeatureSettings.RETRIEVAL_PARAMS)
// The active answer policy (KNOWLEDGE_ANSWER_POLICY), parsed once at boot.
// Unset / malformed ⇒ undefined ⇒ no enforcement.
const ACTIVE_ANSWER_POLICY = parseAnswerPolicy(knowledgeFeatureSettings.KNOWLEDGE_ANSWER_POLICY)

const toolDeps = (extra?: ToolExtra): McpToolDeps => {
  const flags = knowledgeFeatureFlags()
  return {
    tx: getDb(),
    cardsEnabled: flags.cardsEnabled,
    cacheEnabled: flags.cacheEnabled,
    graph: flags.graphragEnabled ? getKnowledgeGraphRepo() : undefined,
    scopes: extra?.authInfo?.scopes,
    actorUuid: extra?.authInfo?.clientId ?? null,
    blobStore: getKnowledgeBlobStore(),
    retrievalParams: ACTIVE_RETRIEVAL_PARAMS,
    faithfulnessTierB: flags.faithfulnessTierBEnabled,
    contestedSources: flags.contestedSourcesEnabled,
    evalHarvest: flags.evalHarvestEnabled,
    answerPolicy: ACTIVE_ANSWER_POLICY,
    acceptanceEvaluator: flags.acceptanceEvaluatorEnabled,
    piiRedaction: flags.piiRedactionEnabled,
  }
}

/**
 * Runs a tool inside the caller's tenant context: opens a transaction with the
 * `app.current_tenant` GUC set from the verified token, so row-level security
 * scopes every query (and the answer cache) to that tenant. Single-tenant tokens
 * carry the default tenant, so this is uniform and safe for both modes.
 */
const runTenantScoped = async <T>(
  extra: ToolExtra,
  run: (deps: McpToolDeps) => Promise<T>,
): Promise<T> => {
  const tenantId = extra.authInfo?.extra?.tenantId ?? DEFAULT_TENANT_ID
  return withTenant(getDb(), tenantId, async (tx) => run({ ...toolDeps(extra), tx }))
}

/**
 * Registers one knowledge tool. The two `as never` casts bridge a purely
 * type-level mismatch between the app's zod v4 and the SDK's own zod identity;
 * we `safeParse` inside so the handler always receives validated args.
 */
const registerKlTool = <S extends z.ZodType>(
  server: McpServer,
  name: string,
  title: string,
  description: string,
  schema: S,
  handle: (args: z.infer<S>, extra: ToolExtra) => Promise<ToolResult>,
): void => {
  server.registerTool(name, { title, description, inputSchema: schema as never }, (async (
    raw: unknown,
    extra: ToolExtra,
  ): Promise<ToolResult> => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      return errorContent(`${name}: invalid arguments`)
    }
    return handle(parsed.data as z.infer<S>, extra)
  }) as never)
}

const handler = createMcpHandler(
  (server) => {
    registerKlTool(
      server,
      "kl_search",
      "Search knowledge base",
      "Search the knowledge base by semantic similarity. Returns the top-K passages with material titles and scores.",
      klSearchInput,
      async (args, extra) => {
        try {
          return jsonContent(await runTenantScoped(extra, async (d) => klSearch(d, args)))
        } catch (error) {
          return errorContent(error instanceof Error ? error.message : "kl_search failed")
        }
      },
    )

    registerKlTool(
      server,
      "kl_ask_global",
      "Ask the knowledge base",
      "Ask a natural-language question. Retrieves relevant passages, synthesises an answer, and returns citation markers keyed to source materials. The result carries a `status` you can gate on (supported | partial | unsupported | conflicted | needs_review) plus the signals behind it (groundedness, unsupportedClaims, optional semanticGroundedness/contradictedClaims, contested). Optional intent/facts tailor the answer to the calling agent's goal.",
      klAskGlobalInput,
      async (args, extra) => {
        try {
          return jsonContent(await runTenantScoped(extra, async (d) => klAskGlobal(d, args)))
        } catch (error) {
          return errorContent(error instanceof Error ? error.message : "kl_ask_global failed")
        }
      },
    )

    registerKlTool(
      server,
      "kl_get_material",
      "Get material",
      "Fetch metadata for a single material by its UUID.",
      klGetMaterialInput,
      async (args, extra) => {
        try {
          return jsonContent(await runTenantScoped(extra, async (d) => klGetMaterial(d, args)))
        } catch (error) {
          return errorContent(error instanceof Error ? error.message : "kl_get_material failed")
        }
      },
    )

    registerKlTool(
      server,
      "kl_signal",
      "Emit feedback signal",
      "Emit a programmatic feedback signal (verified_supported, eval_passed, downstream_failure, …) on a prior answer by its askId. Drives the self-improving compounding loop without a human. Requires the knowledge:signal scope.",
      klSignalInput,
      async (args, extra) => {
        try {
          return jsonContent(await runTenantScoped(extra, async (d) => klSignal(d, args)))
        } catch (error) {
          return errorContent(error instanceof Error ? error.message : "kl_signal failed")
        }
      },
    )

    registerKlTool(
      server,
      "hitl_request",
      "Request human input",
      "Ask a human for a decision and suspend the loop on it (human-in-the-loop as a tool call). Returns immediately with { id, status: 'pending' } — it does NOT block for the answer; the durable request survives a long wait and a killed process. The human answers via hitl_respond and a worker resumes the paused consumer. Requires the hitl:request scope.",
      hitlRequestInput,
      async (args, extra) => {
        try {
          return jsonContent(await runTenantScoped(extra, async (d) => hitlRequest(d, args)))
        } catch (error) {
          return errorContent(error instanceof Error ? error.message : "hitl_request failed")
        }
      },
    )

    registerKlTool(
      server,
      "hitl_respond",
      "Respond to a human-input request",
      "Deliver a human's answer to a pending hitl_request by id, marking it answered so the paused loop can resume. Requires the elevated hitl:respond scope (a human-facing token, not the requesting agent's own).",
      hitlRespondInput,
      async (args, extra) => {
        try {
          return jsonContent(await runTenantScoped(extra, async (d) => hitlRespond(d, args)))
        } catch (error) {
          return errorContent(error instanceof Error ? error.message : "hitl_respond failed")
        }
      },
    )

    registerKlTool(
      server,
      "hitl_get",
      "Poll a human-input request",
      "Poll your own pending hitl_request by id to read the human's answer and resume. Returns { id, status, response, expiresAt }; status is 'pending' until answered, then 'answered' (or 'expired'). Authorized to the requester only. Requires the hitl:request scope.",
      hitlGetInput,
      async (args, extra) => {
        try {
          return jsonContent(await runTenantScoped(extra, async (d) => hitlGet(d, args)))
        } catch (error) {
          return errorContent(error instanceof Error ? error.message : "hitl_get failed")
        }
      },
    )

    registerKlTool(
      server,
      "mem_recall",
      "Recall memory",
      "Recall your beliefs (your private memory ∪ shared memory). Filter by subject or semantic query; pass asOf (ISO time) to time-travel to what was believed then.",
      memRecallInput,
      async (args, extra) => {
        try {
          return jsonContent(await runTenantScoped(extra, async (d) => memRecall(d, args)))
        } catch (error) {
          return errorContent(error instanceof Error ? error.message : "mem_recall failed")
        }
      },
    )

    registerKlTool(
      server,
      "mem_write",
      "Write memory",
      "Record a belief into your private memory (subject, predicate, object, confidence). Belief-revision-aware. Requires the memory:write scope.",
      memWriteInput,
      async (args, extra) => {
        try {
          return jsonContent(await runTenantScoped(extra, async (d) => memWrite(d, args)))
        } catch (error) {
          return errorContent(error instanceof Error ? error.message : "mem_write failed")
        }
      },
    )

    registerKlTool(
      server,
      "mem_forget",
      "Forget memory",
      "Retract one of your own beliefs by id. Soft + bitemporal: it drops from current memory but stays recallable via mem_recall `asOf`. The memory counterpart of kl_forget. Requires the elevated memory:admin scope.",
      memForgetInput,
      async (args, extra) => {
        try {
          return jsonContent(await runTenantScoped(extra, async (d) => memForget(d, args)))
        } catch (error) {
          return errorContent(error instanceof Error ? error.message : "mem_forget failed")
        }
      },
    )

    registerKlTool(
      server,
      "kl_ingest",
      "Ingest knowledge",
      "Add text to the knowledge base (chunked, embedded, distilled into fact cards, graph-extracted). Requires knowledge:write. Optional `lifecycle` (active | deprecated | superseded | archived) and `trustTier` tag the source's trust so retrieval prefers current, higher-trust material. Later kl_ask_global / kl_search can cite it.",
      klIngestInput,
      async (args, extra) => {
        try {
          return jsonContent(await runTenantScoped(extra, async (d) => klIngest(d, args)))
        } catch (error) {
          return errorContent(error instanceof Error ? error.message : "kl_ingest failed")
        }
      },
    )

    registerKlTool(
      server,
      "kl_compile_skill",
      "Compile skill",
      "Compile a reusable, fully-cited SKILL.md for a target behaviour from the knowledge base: retrieve the corpus slice, extract imperative directives + negative examples (each cited), then fail-closed on a structural gate AND a decorrelated L2 faithfulness judge (a different model family than the extractor) before persisting a versioned skill. Requires knowledge:write. Needs a distinct CHAT_JUDGE_MODEL — an unset one fails closed rather than judging with the same mind.",
      klCompileSkillInput,
      async (args, extra) => {
        try {
          return jsonContent(await runTenantScoped(extra, async (d) => klCompileSkill(d, args)))
        } catch (error) {
          return errorContent(error instanceof Error ? error.message : "kl_compile_skill failed")
        }
      },
    )

    registerKlTool(
      server,
      "kl_forget",
      "Forget knowledge",
      "Permanently delete a material by its UUID and everything derived from it (chunks, cards, graph). The inverse of kl_ingest, for retraction / right-to-erasure. Requires the knowledge:admin scope.",
      klForgetInput,
      async (args, extra) => {
        try {
          return jsonContent(await runTenantScoped(extra, async (d) => klForget(d, args)))
        } catch (error) {
          return errorContent(error instanceof Error ? error.message : "kl_forget failed")
        }
      },
    )

    // Layer-2 tool only when GraphRAG is enabled.
    if (knowledgeFeatureFlags().graphragEnabled && getKnowledgeGraphRepo() !== undefined) {
      registerKlTool(
        server,
        "kl_graph_neighbors",
        "Graph neighbors",
        "Find materials related to a given material via the knowledge graph (sharing an extracted entity).",
        klGraphNeighborsInput,
        async (args, extra) => {
          try {
            return jsonContent(await runTenantScoped(extra, async (d) => klGraphNeighbors(d, args)))
          } catch (error) {
            return errorContent(
              error instanceof Error ? error.message : "kl_graph_neighbors failed",
            )
          }
        },
      )
    }
  },
  {
    serverInfo: { name: "agenticmind-knowledge", version: MCP_CONTRACT_VERSION },
    capabilities: { tools: {} },
  },
  {
    // Mcp-handler mounts the streamable transport at `${basePath}/mcp`, so an
    // Empty basePath serves it at /mcp — the URL the README documents. (index.ts
    // Already routes /mcp here.)
    basePath: "",
    maxDuration: 60,
  },
)

// Static-key principal (a fixed UUID so memory writes have a stable owner) and
// the scopes a static key grants — everything, since it is the trusted
// single-tenant key. For least-privilege, use minted JWTs instead.
const API_KEY_PRINCIPAL = "00000000-0000-0000-0000-000000000001"
const API_KEY_SCOPES = [
  "knowledge:read",
  "knowledge:write",
  "knowledge:admin",
  "memory:read",
  "memory:write",
  "memory:admin",
  AUDIT_WRITE_SCOPE,
]

/** Constant-time string compare (avoid leaking the key through timing). */
const constantTimeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Fail-closed bearer verification. Two accepted forms:
 *   1) the static `MCP_API_KEY` (simple single-tenant — no mint, no DB row), or
 *   2) a per-token typ="mcp" JWT whose jti is active (least-privilege, revocable).
 */
export const verifyMcpAccess = async (
  _req: Request,
  bearer?: string,
): Promise<AuthInfo | undefined> => {
  if (bearer === undefined || bearer === "") {
    return undefined
  }
  const apiKey = mcpSettings.MCP_API_KEY
  if (apiKey !== undefined && apiKey.length > 0 && constantTimeEqual(bearer, apiKey)) {
    return {
      token: bearer,
      scopes: API_KEY_SCOPES,
      clientId: API_KEY_PRINCIPAL,
      extra: { userUuid: API_KEY_PRINCIPAL, actorType: "service", tenantId: DEFAULT_TENANT_ID },
    }
  }
  const verified = await verifyMcpToken(bearer)
  if (verified === null) {
    return undefined
  }
  const check = await checkMcpToken({ tx: getDb(), jti: verified.jti }).unwrapOr({
    active: false as const,
    reason: "unknown" as const,
  })
  if (!check.active) {
    return undefined
  }
  const scopes = check.scopes.length > 0 ? check.scopes : ["knowledge:read"]
  return {
    token: bearer,
    scopes,
    clientId: verified.userUuid,
    extra: {
      userUuid: verified.userUuid,
      jti: verified.jti,
      actorType: check.actorType,
      tenantId: check.tenantId,
    },
  }
}

/** The MCP fetch handler — bearer-gated, requires knowledge:read at the endpoint. */
export const mcpFetch = withMcpAuth(handler, verifyMcpAccess, {
  required: true,
  requiredScopes: ["knowledge:read"],
})
