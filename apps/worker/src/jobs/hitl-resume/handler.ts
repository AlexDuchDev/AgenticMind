/**
 * HITL resume sweep (durable-HITL engine, Tier 2). Under a transaction-scoped advisory lock
 * (single-writer per sweep), selects answered remediation-approval requests, drives each through the
 * remediation ledger (resumeRemediation), and settles it resumed|failed — all in ONE transaction, so
 * a crash rolls back atomically and the row is re-processed next tick (durability without a lease).
 */
import type { Transaction } from "@agenticmind/shared/database/client"

import {
  selectAnsweredHitlRequests,
  settleHitlRequest,
} from "@agenticmind/shared/database/query/hitl/requests"
import { SpanKind, withSpan } from "@agenticmind/shared/lib/observability/trace"

import { REMEDIATION_KIND, resumeRemediation } from "./remediation"

/** Max requests resumed per sweep tick — back-pressure. */
const RESUME_BATCH = 20

export const runHitlResumeSweep = async (db: Transaction): Promise<void> =>
  withSpan("hitl.resume_sweep", SpanKind.CHAIN, async (span) => {
    const answered = await selectAnsweredHitlRequests({
      tx: db,
      kind: REMEDIATION_KIND,
      limit: RESUME_BATCH,
    })
    if (answered.isErr()) {
      span.setAttribute("hitl.resume_failed", true)
      console.error("[HITL_RESUME] select failed:", answered.error)
      return
    }
    span.setAttribute("hitl.answered", answered.value.length)

    const at = new Date().toISOString()
    let resumed = 0
    let failed = 0
    for (const row of answered.value) {
      try {
        const { outcome } = resumeRemediation(row, at)
        const settled = await settleHitlRequest({ tx: db, id: row.id, status: "resumed" })
        if (settled.isErr()) {
          console.error("[HITL_RESUME] settle(resumed) failed:", settled.error)
        } else if (settled.value.length > 0) {
          resumed += 1
          console.log(`[HITL_RESUME] ${row.id}: ${outcome}`)
        }
      } catch (error: unknown) {
        // A malformed payload or an illegal ledger transition is terminal — settle `failed` (in the
        // same tx) so it is not re-processed forever.
        const settled = await settleHitlRequest({ tx: db, id: row.id, status: "failed" })
        if (settled.isOk() && settled.value.length > 0) {
          failed += 1
        }
        console.error(`[HITL_RESUME] ${row.id} resume failed:`, error)
      }
    }
    span.setAttribute("hitl.resumed", resumed)
    span.setAttribute("hitl.failed", failed)
  })
