/**
 * Durable-HITL MCP tool handlers (12-Factor F7). Pins the Cycle-of-Trust gates that make the
 * human-in-the-loop real: an agent cannot request anonymously, cannot ANSWER its own request
 * (hitl_respond needs the elevated hitl:respond scope a plain agent token must not hold), and can
 * only read its OWN request (hitl_get). The DB-level CAS (pending→answered once, self-answer refused
 * at the SQL layer) is exercised by the query layer against Postgres; here we pin the handler
 * contract with the repo.
 *
 * Mocks are `mock`-prefixed vi.fn()s reached through delegating closures in an explicit factory, so
 * the suite runs under BOTH `bun test` (native — the CI `check (bun)` gate; no vi.hoisted, no
 * factory-less auto-mock) and vitest (`check (npm)`).
 */
// oxlint-disable-next-line import/no-unassigned-import -- side-effect: SKIP_VALIDATION before settings load
import "@agenticmind/shared/lib/knowledge/_test-env"
import { ok } from "neverthrow"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { hitlGet, hitlRequest, hitlRespond } from "./mcp-tools"

const mockCreate = vi.fn()
const mockAnswer = vi.fn()
const mockGet = vi.fn()
const mockRate = vi.fn()

vi.mock("@agenticmind/shared/database/query/hitl/requests", () => {
  return {
    createHitlRequest: (...args: unknown[]) => mockCreate(...args),
    answerHitlRequest: (...args: unknown[]) => mockAnswer(...args),
    getHitlRequest: (...args: unknown[]) => mockGet(...args),
  }
})
vi.mock("@agenticmind/shared/database/query/knowledge/rate-limits", () => {
  return { checkRateLimit: (...args: unknown[]) => mockRate(...args) }
})

const tx = {} as never

beforeEach(() => {
  mockCreate.mockReset()
  mockAnswer.mockReset()
  mockGet.mockReset()
  mockRate.mockReset()
  mockRate.mockReturnValue(ok({ allowed: true }) as never)
})

describe("hitl_request", () => {
  it("refuses an agent without the hitl:request scope", async () => {
    await expect(hitlRequest({ scopes: [], tx }, { question: "Approve?" })).rejects.toThrow(
      "hitl:request",
    )
  })

  it("refuses an anonymous request (no agent identity on the token)", async () => {
    await expect(
      hitlRequest({ scopes: ["hitl:request"], actorUuid: null, tx }, { question: "Approve?" }),
    ).rejects.toThrow("no agent identity")
  })

  it("rejects a reserved 'internal:' kind (an agent cannot forge an internal request)", async () => {
    await expect(
      hitlRequest(
        { scopes: ["hitl:request"], actorUuid: "agent-1", tx },
        { question: "Approve?", kind: "internal:remediation_approval" },
      ),
    ).rejects.toThrow("reserved")
  })

  it("creates a pending request and echoes the idempotency key", async () => {
    mockCreate.mockReturnValue(ok("row-1") as never)

    const res = await hitlRequest(
      { scopes: ["hitl:request"], actorUuid: "agent-1", tx },
      { question: "Approve the deploy?", requestId: "corr-1" },
    )

    expect(res).toEqual({ id: "row-1", requestId: "corr-1", status: "pending" })
    expect(mockCreate).toHaveBeenCalledOnce()
  })
})

describe("hitl_respond", () => {
  it("refuses a token without the elevated hitl:respond scope (an agent cannot answer itself)", async () => {
    await expect(
      hitlRespond(
        { scopes: ["hitl:request"], actorUuid: "agent-1", tx },
        { id: "row-1", answer: "yes" },
      ),
    ).rejects.toThrow("hitl:respond")
  })

  it("rejects a response to a request that is missing or no longer pending", async () => {
    mockAnswer.mockReturnValue(ok([]) as never)

    await expect(
      hitlRespond(
        { scopes: ["hitl:respond"], actorUuid: "human-1", tx },
        { id: "row-1", answer: "yes" },
      ),
    ).rejects.toThrow("not found or no longer pending")
  })

  it("marks a pending request answered", async () => {
    mockAnswer.mockReturnValue(ok([{ id: "row-1" }]) as never)

    const res = await hitlRespond(
      { scopes: ["hitl:respond"], actorUuid: "human-1", tx },
      { id: "row-1", answer: "approved" },
    )

    expect(res).toEqual({ id: "row-1", status: "answered" })
    expect(mockAnswer).toHaveBeenCalledOnce()
  })
})

describe("hitl_get", () => {
  const row = (over: Record<string, unknown>) => {
    return {
      id: "row-1",
      status: "answered",
      response: { answer: "approved" },
      requestedBy: "agent-1",
      expiresAt: null,
      ...over,
    }
  }

  it("refuses a poll without the hitl:request scope", async () => {
    await expect(
      hitlGet({ scopes: [], actorUuid: "agent-1", tx }, { id: "row-1" }),
    ).rejects.toThrow("hitl:request")
  })

  it("returns the answer to the asking agent", async () => {
    mockGet.mockReturnValue(ok(row({})) as never)

    const res = await hitlGet(
      { scopes: ["hitl:request"], actorUuid: "agent-1", tx },
      { id: "row-1" },
    )

    expect(res).toEqual({
      id: "row-1",
      status: "answered",
      response: { answer: "approved" },
      expiresAt: null,
    })
  })

  it("hides another actor's request (authorized to the requester only)", async () => {
    mockGet.mockReturnValue(ok(row({ requestedBy: "agent-2" })) as never)

    await expect(
      hitlGet({ scopes: ["hitl:request"], actorUuid: "agent-1", tx }, { id: "row-1" }),
    ).rejects.toThrow("not found")
  })

  it("reports not found for a missing request", async () => {
    mockGet.mockReturnValue(ok(null) as never)

    await expect(
      hitlGet({ scopes: ["hitl:request"], actorUuid: "agent-1", tx }, { id: "row-1" }),
    ).rejects.toThrow("not found")
  })
})
