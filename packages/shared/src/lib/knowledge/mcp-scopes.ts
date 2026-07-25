/**
 * MCP capability scopes — least-privilege per token. Read tools need
 * `knowledge:read`; emitting compounding signals needs `knowledge:signal`;
 * ingestion needs `knowledge:write`; permanently deleting a material
 * (kl_forget) needs the elevated `knowledge:admin`. Enforcement lives in code
 * (the tool handlers + the route), never in a prompt — Cycle of Trust, Standard
 * antipattern #4.
 */

export const KNOWLEDGE_SCOPES = [
  "knowledge:read",
  "knowledge:signal",
  "knowledge:write",
  "knowledge:admin",
  "memory:read",
  "memory:write",
  "memory:admin",
  "hitl:request",
  "hitl:respond",
] as const

export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number]

/** Default grant for a freshly-minted token: read-only. */
export const DEFAULT_SCOPES: KnowledgeScope[] = ["knowledge:read"]

export const isKnowledgeScope = (s: string): s is KnowledgeScope =>
  (KNOWLEDGE_SCOPES as readonly string[]).includes(s)

/** True when `granted` contains `required`. Undefined/empty grants nothing. */
export const hasScope = (
  granted: readonly string[] | undefined | null,
  required: KnowledgeScope,
): boolean => granted !== undefined && granted !== null && granted.includes(required)

/** The scope each MCP tool requires. */
export const TOOL_SCOPE: Record<string, KnowledgeScope> = {
  kl_search: "knowledge:read",
  kl_ask_global: "knowledge:read",
  kl_get_material: "knowledge:read",
  kl_graph_neighbors: "knowledge:read",
  kl_signal: "knowledge:signal",
  kl_ingest: "knowledge:write",
  kl_forget: "knowledge:admin",
  mem_recall: "memory:read",
  mem_write: "memory:write",
  mem_forget: "memory:admin",
  hitl_request: "hitl:request",
  hitl_respond: "hitl:respond",
  hitl_get: "hitl:request",
}
