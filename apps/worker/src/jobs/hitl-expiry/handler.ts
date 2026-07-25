/**
 * HITL expiry sweep (durable-HITL engine / Loop License #6 — escalation). Flips pending requests
 * past their deadline to `expired` and escalates each through the pluggable notifier, so "a human
 * never answered in time" becomes a durable, visible event instead of a silently-stuck paused loop.
 *
 * A notifier failure never fails the sweep — the rows are already expired by the time we notify.
 * Payload-free: only ids/kinds cross the channel, never the question text (hash-not-text holds).
 */
import type { AssuranceNotifier } from "@agenticmind/assurance"
import type { Transaction } from "@agenticmind/shared/database/client"

import { consoleNotifier } from "@agenticmind/assurance"
import { expireStaleHitlRequests } from "@agenticmind/shared/database/query/hitl/requests"
import { SpanKind, withSpan } from "@agenticmind/shared/lib/observability/trace"

/** Max rows expired per sweep tick — back-pressure so a deadline storm can't flood memory/notifier. */
const EXPIRY_BATCH = 200

export const runHitlExpirySweep = async (
  db: Transaction,
  notify: AssuranceNotifier = consoleNotifier,
): Promise<void> =>
  withSpan("hitl.expiry_sweep", SpanKind.CHAIN, async (span) => {
    const expired = await expireStaleHitlRequests({ tx: db, limit: EXPIRY_BATCH })
    if (expired.isErr()) {
      // Surface the failure on the span so a permanently-failing sweep is visible in traces,
      // not just the log — stale requests silently not escalating is exactly the Loop-License risk.
      span.setAttribute("hitl.sweep_failed", true)
      console.error("[HITL_EXPIRY] sweep failed:", expired.error)
      return
    }
    span.setAttribute("hitl.expired", expired.value.length)
    if (expired.value.length === 0) {
      return
    }
    for (const row of expired.value) {
      // Escalate each expired request. A rich channel renders the ids; the paused consumer is now
      // free to be re-driven or abandoned by whoever owns the escalation path.
      try {
        await notify({
          kind: "approval-request",
          severity: "warning",
          title: "HITL request expired — escalation",
          body: `Request ${row.id} (${row.kind}) passed its deadline with no human answer.`,
          context: { id: row.id, kind: row.kind, requestedBy: row.requestedBy },
        })
      } catch (error: unknown) {
        console.error("[HITL_EXPIRY] notifier failed:", error)
      }
    }
  })
