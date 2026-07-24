// AgenticMind schema barrel — knowledge core + principal only.
// The per-ask audit trail is `ask_telemetry`; feedback signals key off it.
// (There are no multi-route assistant tables — the MCP path calls ask() directly.)

import * as AssuranceRuns from "@agenticmind/shared/database/schema/assurance/runs"
import * as HitlRequests from "@agenticmind/shared/database/schema/hitl/requests"
import * as KnowledgeAnswerCache from "@agenticmind/shared/database/schema/knowledge/answer-cache"
import * as KnowledgeAskClusterMembers from "@agenticmind/shared/database/schema/knowledge/ask-cluster-members"
import * as KnowledgeAskClusters from "@agenticmind/shared/database/schema/knowledge/ask-clusters"
import * as KnowledgeAskFeedback from "@agenticmind/shared/database/schema/knowledge/ask-feedback"
import * as KnowledgeAskTelemetry from "@agenticmind/shared/database/schema/knowledge/ask-telemetry"
import * as KnowledgeBeliefs from "@agenticmind/shared/database/schema/knowledge/beliefs"
import * as KnowledgeChunks from "@agenticmind/shared/database/schema/knowledge/chunks"
import * as KnowledgeGraph from "@agenticmind/shared/database/schema/knowledge/graph"
import * as KnowledgeGuardEvents from "@agenticmind/shared/database/schema/knowledge/guard-events"
import * as KnowledgeCards from "@agenticmind/shared/database/schema/knowledge/knowledge-cards"
import * as KnowledgeMaterials from "@agenticmind/shared/database/schema/knowledge/materials"
import * as KnowledgeMcpTokens from "@agenticmind/shared/database/schema/knowledge/mcp-tokens"
import * as KnowledgeRateLimits from "@agenticmind/shared/database/schema/knowledge/rate-limits"
import * as KnowledgeSkills from "@agenticmind/shared/database/schema/knowledge/skills"
import * as KnowledgeToolAuditEvents from "@agenticmind/shared/database/schema/knowledge/tool-audit-events"
import * as Users from "@agenticmind/shared/database/schema/users"

export * from "@agenticmind/shared/database/schema/users"

export * from "@agenticmind/shared/database/schema/knowledge/answer-cache"
export * from "@agenticmind/shared/database/schema/knowledge/ask-cluster-members"
export * from "@agenticmind/shared/database/schema/knowledge/ask-clusters"
export * from "@agenticmind/shared/database/schema/knowledge/ask-feedback"
export * from "@agenticmind/shared/database/schema/knowledge/ask-telemetry"
export * from "@agenticmind/shared/database/schema/knowledge/beliefs"
export * from "@agenticmind/shared/database/schema/knowledge/guard-events"
export * from "@agenticmind/shared/database/schema/knowledge/rate-limits"
export * from "@agenticmind/shared/database/schema/knowledge/knowledge-cards"
export * from "@agenticmind/shared/database/schema/knowledge/chunks"
export * from "@agenticmind/shared/database/schema/knowledge/graph"
export * from "@agenticmind/shared/database/schema/knowledge/materials"
export * from "@agenticmind/shared/database/schema/knowledge/mcp-tokens"
export * from "@agenticmind/shared/database/schema/knowledge/skills"
export * from "@agenticmind/shared/database/schema/knowledge/tool-audit-events"
export * from "@agenticmind/shared/database/schema/assurance/runs"
export * from "@agenticmind/shared/database/schema/hitl/requests"

export const schema = {
  ...Users,
  ...KnowledgeMaterials,
  ...KnowledgeChunks,
  ...KnowledgeCards,
  ...KnowledgeAnswerCache,
  ...KnowledgeAskTelemetry,
  ...KnowledgeAskFeedback,
  ...KnowledgeAskClusters,
  ...KnowledgeAskClusterMembers,
  ...KnowledgeMcpTokens,
  ...KnowledgeGraph,
  ...KnowledgeBeliefs,
  ...KnowledgeGuardEvents,
  ...KnowledgeRateLimits,
  ...KnowledgeSkills,
  ...KnowledgeToolAuditEvents,
  ...AssuranceRuns,
  ...HitlRequests,
}
