/**
 * Postgres-native scheduler for the HITL resume sweep (durable-HITL engine, Tier 2). Mirrors the
 * expiry scheduler: a periodic timer + a transaction-scoped advisory lock so exactly one replica
 * sweeps at a time (the single-writer guarantee the atomic select→resume→settle relies on). No broker.
 */

import { sql } from "drizzle-orm"

import { db } from "@/lib/database"

import { runHitlResumeSweep } from "./handler"

/** Advisory-lock key for the HITL resume sweep (distinct from feedback / drift / expiry 4_242_044). */
const ADVISORY_LOCK_KEY = 4_242_045
/** How often to resume answered requests. Seconds-scale — a human's answer should take effect promptly. */
const POLL_INTERVAL_MS = 10_000

const runGuarded = async (): Promise<void> => {
  await db.transaction(async (tx) => {
    const res = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked`,
    )
    const locked = (res.rows[0] as { locked?: boolean } | undefined)?.locked === true
    if (!locked) {
      return
    }
    await runHitlResumeSweep(tx)
  })
}

export const startHitlResumeScheduler = (): { stop: () => void } => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (): void => {
    timer = setTimeout(() => {
      void (async () => {
        try {
          await runGuarded()
        } catch (error: unknown) {
          console.error("[WORKER] hitl-resume sweep error:", error)
        } finally {
          schedule()
        }
      })()
    }, POLL_INTERVAL_MS)
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
