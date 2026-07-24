/**
 * Remediation as the durable-HITL engine's first internal consumer (Tier 2). Pins the resume
 * decision: an explicit approval drives approve→apply through the actor-enforced ledger; anything
 * else fails closed to a decline; a malformed payload throws (so the sweep settles it `failed`). Also
 * pins that requestRemediationApproval persists a durable, idempotent request keyed by the entry id.
 *
 * Cross-runner mocks (`mock`-prefixed vi.fn + delegating closures) so it runs under bun test + vitest.
 */
import { ok } from "neverthrow"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { REMEDIATION_KIND, requestRemediationApproval, resumeRemediation } from "./remediation"

const mockCreate = vi.fn()

vi.mock("@agenticmind/shared/database/query/hitl/requests", () => {
  return { createHitlRequest: (...args: unknown[]) => mockCreate(...args) }
})

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
const at = "2026-01-02T00:00:00Z"

describe("resumeRemediation", () => {
  it("approves and applies on an explicit approval, crediting the human actor", () => {
    const row = {
      id: "rem:p1",
      payload: { entry: pendingEntry(), edits: [] },
      response: { answer: "approve" },
      answeredBy: "human-1",
    }
    const { outcome } = resumeRemediation(row, at)
    expect(outcome).toContain("apply")
    expect(outcome).toContain("hitl:human-1")
  })

  it("declines on any non-approval answer (fail-closed)", () => {
    const row = {
      id: "rem:p1",
      payload: { entry: pendingEntry(), edits: [] },
      response: { answer: "not sure, hold off" },
      answeredBy: "human-1",
    }
    const { outcome } = resumeRemediation(row, at)
    expect(outcome).toContain("declined")
  })

  it("throws on a malformed payload so the sweep settles it failed", () => {
    const row = {
      id: "rem:p1",
      payload: { nope: true },
      response: { answer: "approve" },
      answeredBy: "human-1",
    }
    expect(() => resumeRemediation(row, at)).toThrow("malformed payload")
  })
})

describe("requestRemediationApproval", () => {
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it("persists a durable, idempotent approval request and notifies a human", async () => {
    mockCreate.mockReturnValue(ok("hitl-1"))
    const notify = vi.fn()

    const id = await requestRemediationApproval(
      { tx: {} as never, entry: pendingEntry() as never, edits: [], requestedBy: "engine" },
      notify,
    )

    expect(id).toBe("hitl-1")
    expect(notify).toHaveBeenCalledOnce()
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      request: { kind: REMEDIATION_KIND, requestId: "rem:p1", requestedBy: "engine" },
    })
  })

  it("refuses an entry that is not pending_approval", async () => {
    const entry = { ...pendingEntry(), state: "approved" }
    await expect(
      requestRemediationApproval({
        tx: {} as never,
        entry: entry as never,
        edits: [],
        requestedBy: "engine",
      }),
    ).rejects.toThrow("not 'pending_approval'")
  })
})
