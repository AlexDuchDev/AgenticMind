/**
 * HITL expiry sweep (durable-HITL engine / Loop License #6). Verifies the escalation behavior that
 * is the whole point of the engine: a pending request no human answered in time is escalated —
 * exactly once per row — and a flaky notifier never fails the sweep. The DB-level state transition
 * (pending→expired via the CAS UPDATE) is exercised by the query layer against Postgres, not here;
 * this pins the handler's orchestration + escalation contract.
 *
 * Mocks are `mock`-prefixed vi.fn()s reached through delegating closures in an explicit factory, so
 * the suite runs under BOTH `bun test` (native — the CI `check (bun)` gate; no vi.hoisted, no
 * factory-less auto-mock) and vitest (`check (npm)`).
 */
import { err, ok } from "neverthrow"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { runHitlExpirySweep } from "./handler"

const mockExpire = vi.fn()

vi.mock("@agenticmind/shared/database/query/hitl/requests", () => {
  return { expireStaleHitlRequests: (...args: unknown[]) => mockExpire(...args) }
})

vi.mock("@agenticmind/shared/lib/observability/trace", () => {
  return {
    SpanKind: { CHAIN: "chain" },
    withSpan: async (
      _name: string,
      _kind: unknown,
      fn: (span: { setAttribute: (...args: unknown[]) => unknown }) => Promise<unknown>,
    ): Promise<unknown> => fn({ setAttribute: (...args: unknown[]) => args.length }),
  }
})

const tx = {} as never
const expiredRow = (id: string) => {
  return { id, kind: "approval", requestedBy: "agent-1", expiresAt: new Date() }
}

describe("runHitlExpirySweep", () => {
  beforeEach(() => {
    mockExpire.mockReset()
  })

  it("escalates each expired request exactly once, payload-free", async () => {
    mockExpire.mockReturnValue(ok([expiredRow("a"), expiredRow("b")]) as never)
    const notify = vi.fn()

    await runHitlExpirySweep(tx, notify)

    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      kind: "approval-request",
      severity: "warning",
      context: { id: "a", kind: "approval", requestedBy: "agent-1" },
    })
    // No raw question text crosses the channel — ids/kinds only.
    expect(JSON.stringify(notify.mock.calls[0]?.[0])).not.toContain("payload")
  })

  it("does not notify when nothing expired", async () => {
    mockExpire.mockReturnValue(ok([]) as never)
    const notify = vi.fn()

    await runHitlExpirySweep(tx, notify)

    expect(notify).not.toHaveBeenCalled()
  })

  it("a flaky notifier never fails the sweep — other rows still escalate", async () => {
    mockExpire.mockReturnValue(ok([expiredRow("a"), expiredRow("b")]) as never)
    const notify = vi.fn().mockRejectedValueOnce(new Error("telegram down"))

    await expect(runHitlExpirySweep(tx, notify)).resolves.toBeUndefined()
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it("swallows a query failure without throwing or notifying", async () => {
    mockExpire.mockReturnValue(err({ type: "database_error", message: "boom" }) as never)
    const notify = vi.fn()

    await expect(runHitlExpirySweep(tx, notify)).resolves.toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
  })
})
