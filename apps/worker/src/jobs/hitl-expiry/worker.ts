/**
 * Postgres-native scheduler for the HITL expiry sweep (durable-HITL engine). Mirrors the
 * assurance-drift scheduler — a periodic timer, a Postgres advisory lock so exactly one replica
 * sweeps, then reschedule. No broker. Interval-scale (not daily): an expired request should escalate
 * within minutes of its deadline, but it is not latency-sensitive to the second.
 */

import type { AssuranceNotifier } from "@agenticmind/assurance"

import { consoleNotifier, makeTelegramNotifier } from "@agenticmind/assurance"
import { sql } from "drizzle-orm"

import { runHitlExpirySweep } from "@/jobs/hitl-expiry/handler"
import { db } from "@/lib/database"

/** Advisory-lock key for the HITL expiry sweep (distinct from feedback / assurance-drift 4_242_043). */
const ADVISORY_LOCK_KEY = 4_242_044
/** How often to sweep for expired requests. Minutes-scale — expiry escalation is not latency-critical. */
const SWEEP_INTERVAL_MS = 5 * 60_000

/**
 * Escalations go to Telegram when both env vars are set, else a console logger. Resolved at the
 * composition root (env is app config), so the sweep and the adapter stay pure and injectable.
 */
// oxlint-disable-next-line node/no-process-env
const TELEGRAM_BOT_TOKEN = process.env.ASSURANCE_TELEGRAM_BOT_TOKEN
// oxlint-disable-next-line node/no-process-env
const TELEGRAM_CHAT_ID = process.env.ASSURANCE_TELEGRAM_CHAT_ID
const notifier: AssuranceNotifier =
  TELEGRAM_BOT_TOKEN !== undefined &&
  TELEGRAM_BOT_TOKEN !== "" &&
  TELEGRAM_CHAT_ID !== undefined &&
  TELEGRAM_CHAT_ID !== ""
    ? makeTelegramNotifier({ botToken: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID })
    : consoleNotifier

/**
 * Runs the sweep iff this instance wins the advisory lock. The lock is taken INSIDE a transaction so
 * it lives on one pinned pool connection (`pg_try_advisory_xact_lock` is transaction-scoped and
 * auto-releases on commit/rollback) — a session lock acquired and released on different pooled
 * connections would orphan it and wedge the sweep forever.
 */
const runGuarded = async (): Promise<void> => {
  await db.transaction(async (tx) => {
    const res = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked`,
    )
    const locked = (res.rows[0] as { locked?: boolean } | undefined)?.locked === true
    if (!locked) {
      return
    }
    await runHitlExpirySweep(tx, notifier)
  })
}

/** Starts the periodic HITL expiry sweep. Returns a stop handle for graceful shutdown. */
export const startHitlExpiryScheduler = (): { stop: () => void } => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (): void => {
    timer = setTimeout(() => {
      void (async () => {
        try {
          await runGuarded()
        } catch (error: unknown) {
          console.error("[WORKER] hitl-expiry sweep error:", error)
        } finally {
          schedule()
        }
      })()
    }, SWEEP_INTERVAL_MS)
  }
  schedule()
  return {
    stop: () => {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    },
  }
}
