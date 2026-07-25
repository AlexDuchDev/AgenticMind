/**
 * HITL resume sweep (Tier 2). Pins the sweep contract: an answered remediation request is resumed and
 * settled `resumed`; a malformed one is settled `failed` (terminal, not retried forever); a select
 * failure returns early without settling. resumeRemediation runs for real against the ledger — only
 * the DB query layer + tracing are mocked.
 *
 * Cross-runner mocks (`mock`-prefixed vi.fn + delegating closures) so it runs under bun test + vitest.
 */
import { err, ok } from "neverthrow"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { runHitlResumeSweep } from "./handler"

const mockSelect = vi.fn()
const mockSettle = vi.fn()

vi.mock("@agenticmind/shared/database/query/hitl/requests", () => {
  return {
    selectAnsweredHitlRequests: (...args: unknown[]) => mockSelect(...args),
    settleHitlRequest: (...args: unknown[]) => mockSettle(...args),
  }
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
const pendingEntry = () => {
  return {
    id: "rem:p1",
    proposalId: "p1",
    findingId: "f1",
    state: "pending_approval",
    verdict: null,
    edits: [],
    history: [
      {
        at: "2026-01-01T00:00:00Z",
        from: null,
        to: "pending_approval",
        actor: "system:gate",
        note: "gated",
      },
    ],
  }
}

describe("runHitlResumeSweep", () => {
  beforeEach(() => {
    mockSelect.mockReset()
    mockSettle.mockReset()
    mockSettle.mockReturnValue(ok([{ id: "x" }]))
  })

  it("resumes an approved remediation and settles it resumed", async () => {
    mockSelect.mockReturnValue(
      ok([
        {
          id: "rem:p1",
          payload: { entry: pendingEntry(), edits: [] },
          response: { answer: "approve" },
          answeredBy: "human-1",
        },
      ]),
    )

    await runHitlResumeSweep(tx)

    expect(mockSettle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rem:p1", status: "resumed" }),
    )
  })

  it("settles a malformed request failed, so it is not retried forever", async () => {
    mockSelect.mockReturnValue(
      ok([
        {
          id: "bad",
          payload: { nope: true },
          response: { answer: "approve" },
          answeredBy: "human-1",
        },
      ]),
    )

    await runHitlResumeSweep(tx)

    expect(mockSettle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bad", status: "failed" }),
    )
  })

  it("returns early on a select failure without settling anything", async () => {
    mockSelect.mockReturnValue(err({ type: "database_error", message: "boom" }))

    await runHitlResumeSweep(tx)

    expect(mockSettle).not.toHaveBeenCalled()
  })
})
