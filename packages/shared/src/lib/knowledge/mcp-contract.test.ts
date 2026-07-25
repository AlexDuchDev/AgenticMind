/**
 * MCP tool contract guard (Agentic Product Standard — Layer 2: the tool surface
 * is a versioned, stable contract that products build on). This test freezes the
 * exposed tool set and each tool's input shape so any change to the public MCP
 * contract is deliberate and reviewed. When you intentionally change the surface,
 * bump the contract version and update CONTRACT below in the same PR.
 */

// oxlint-disable-next-line import/no-unassigned-import -- side-effect import; must run before settings
import "@agenticmind/shared/lib/knowledge/_test-env"
import {
  KNOWLEDGE_MCP_TOOLS,
  MCP_CONTRACT_VERSION,
} from "@agenticmind/shared/lib/knowledge/mcp-tools"
import { describe, expect, it } from "vitest"
import * as z from "zod"

/** The frozen public contract: tool → its input fields and required subset. */
const CONTRACT: Record<string, { fields: string[]; required: string[] }> = {
  kl_ask_global: { fields: ["facts", "intent", "question"], required: ["question"] },
  kl_compile_skill: {
    fields: ["limit", "name", "query", "target", "version"],
    required: ["target"],
  },
  kl_forget: { fields: ["id"], required: ["id"] },
  kl_get_material: { fields: ["id"], required: ["id"] },
  kl_graph_neighbors: { fields: ["limit", "materialId"], required: ["materialId"] },
  kl_ingest: {
    fields: ["language", "lifecycle", "text", "title", "trustTier"],
    required: ["text", "title"],
  },
  kl_search: { fields: ["limit", "q", "queries", "tokenBudget"], required: ["q"] },
  kl_signal: { fields: ["askId", "note", "signal", "strength"], required: ["askId", "signal"] },
  mem_recall: { fields: ["asOf", "includeShared", "limit", "query", "subject"], required: [] },
  mem_write: {
    fields: ["confidence", "embed", "object", "predicate", "subject"],
    required: ["object", "predicate", "subject"],
  },
  mem_forget: { fields: ["id"], required: ["id"] },
  hitl_request: {
    fields: ["context", "expiresInSeconds", "kind", "question", "requestId"],
    required: ["question"],
  },
  hitl_respond: { fields: ["answer", "id"], required: ["answer", "id"] },
  hitl_get: { fields: ["id"], required: ["id"] },
}

const shapeOf = (schema: unknown): { fields: string[]; required: string[] } => {
  const json = z.toJSONSchema(schema as z.ZodType) as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  return {
    fields: Object.keys(json.properties ?? {}).toSorted(),
    required: (json.required ?? []).slice().toSorted(),
  }
}

describe("MCP tool contract", () => {
  it("exposes exactly the canonical tool set", () => {
    const names = KNOWLEDGE_MCP_TOOLS.map((t) => t.name).toSorted()
    expect(names).toEqual(Object.keys(CONTRACT).toSorted())
  })

  it("carries a SemVer contract version", () => {
    expect(MCP_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/u)
  })

  it("every tool has a prompt-quality description", () => {
    for (const tool of KNOWLEDGE_MCP_TOOLS) {
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(20)
    }
  })

  it("freezes each tool's input fields and required subset", () => {
    for (const tool of KNOWLEDGE_MCP_TOOLS) {
      const expected = CONTRACT[tool.name]
      if (expected === undefined) {
        throw new Error(`unexpected tool '${tool.name}' — update CONTRACT`)
      }
      expect(shapeOf(tool.inputSchema), `${tool.name} input shape`).toEqual({
        fields: expected.fields.slice().toSorted(),
        required: expected.required.slice().toSorted(),
      })
    }
  })
})
