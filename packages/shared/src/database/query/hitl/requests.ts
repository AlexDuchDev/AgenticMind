/**
 * Durable HITL request repo (12-Factor F7). The operations the engine needs: create on ask
 * (idempotent per requester), read by id (the asking agent polls its own to resume), CAS-answer
 * (pending→answered, by someone other than the asker), and a bounded sweep of stale pending rows to
 * expired for escalation (Loop License #6).
 *
 * Convention: `{ tx }` props, neverthrow ResultAsync, the single generic mapDatabaseError. A CAS
 * update returns zero rows when the row was no longer in the expected state — the caller decides
 * what that means (not found / already answered / raced / self-answer refused), rather than a tagged
 * error class.
 */
import type { Transaction } from "@agenticmind/shared/database/client"
import type { HitlRequestInsert, HitlRequestSelect } from "@agenticmind/shared/database/schema"

import { mapDatabaseError } from "@agenticmind/shared/database/database-error"
import { hitlRequests } from "@agenticmind/shared/database/schema"
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm"
import { ResultAsync } from "neverthrow"

/** Create a pending request, idempotent on (requestedBy, requestId) — a retry returns the existing id. */
export const createHitlRequest = (props: { tx: Transaction; request: HitlRequestInsert }) =>
  ResultAsync.fromPromise(
    (async () => {
      const [row] = await props.tx
        .insert(hitlRequests)
        .values(props.request)
        .onConflictDoUpdate({
          target: [hitlRequests.requestedBy, hitlRequests.requestId],
          set: { requestId: props.request.requestId }, // no-op: a conflict just returns the existing row
        })
        .returning({ id: hitlRequests.id })
      if (row === undefined) {
        throw new Error("createHitlRequest inserted no row")
      }
      return row.id
    })(),
    mapDatabaseError,
  )

/** Read one request by id (null if absent). The asking agent polls this to read its answer + resume. */
export const getHitlRequest = (props: { tx: Transaction; id: string }) =>
  ResultAsync.fromPromise(
    props.tx.select().from(hitlRequests).where(eq(hitlRequests.id, props.id)).limit(1),
    mapDatabaseError,
  ).map((rows): HitlRequestSelect | null => rows[0] ?? null)

/**
 * CAS-answer: flips pending→answered only if still pending AND the answerer is not the asker
 * (`requestedBy != answeredBy` — the structural belt under the Cycle-of-Trust scope gate, so a single
 * mis-granted `hitl:respond` cannot let an agent answer itself). Zero returned rows ⇒ "not found, no
 * longer pending, or self-answer refused".
 */
export const answerHitlRequest = (props: {
  tx: Transaction
  id: string
  answeredBy: string
  response: unknown
}) =>
  ResultAsync.fromPromise(
    props.tx
      .update(hitlRequests)
      .set({
        status: "answered",
        response: props.response,
        answeredBy: props.answeredBy,
        answeredAt: sql`now()`,
      })
      .where(
        and(
          eq(hitlRequests.id, props.id),
          eq(hitlRequests.status, "pending"),
          ne(hitlRequests.requestedBy, props.answeredBy),
        ),
      )
      .returning({ id: hitlRequests.id }),
    mapDatabaseError,
  )

/**
 * Bounded sweep: flip up to `limit` pending rows past their deadline to expired, returning them so
 * the caller can escalate (Loop License #6). Rows with no `expiresAt` never expire (`lt` on null is
 * null ⇒ excluded). The `limit` gives back-pressure so a deadline storm can't pull the whole backlog
 * into memory or flood the notifier in one tick. Concurrency across replicas is handled by the
 * caller's advisory lock, so no row-lock is needed here.
 */
export const expireStaleHitlRequests = (props: { tx: Transaction; limit: number }) => {
  const stale = props.tx
    .select({ id: hitlRequests.id })
    .from(hitlRequests)
    .where(and(eq(hitlRequests.status, "pending"), lt(hitlRequests.expiresAt, sql`now()`)))
    .orderBy(hitlRequests.expiresAt)
    .limit(props.limit)
  return ResultAsync.fromPromise(
    props.tx
      .update(hitlRequests)
      .set({ status: "expired" })
      .where(inArray(hitlRequests.id, stale))
      .returning({
        id: hitlRequests.id,
        kind: hitlRequests.kind,
        requestedBy: hitlRequests.requestedBy,
        expiresAt: hitlRequests.expiresAt,
      }),
    mapDatabaseError,
  )
}

/**
 * Select answered rows of a `kind` for an internal worker to resume. The worker runs under a
 * transaction-scoped advisory lock (single-writer per sweep), so it selects + resumes + settles in
 * ONE transaction — no claim/lease is needed, and a crashed sweep rolls back atomically, leaving the
 * rows `answered` to be re-processed next tick. (External MCP agents do not use this path — they poll
 * hitl_get and resume themselves.)
 */
export const selectAnsweredHitlRequests = (props: {
  tx: Transaction
  kind: string
  limit: number
}) =>
  ResultAsync.fromPromise(
    props.tx
      .select({
        id: hitlRequests.id,
        payload: hitlRequests.payload,
        response: hitlRequests.response,
        answeredBy: hitlRequests.answeredBy,
      })
      .from(hitlRequests)
      .where(and(eq(hitlRequests.status, "answered"), eq(hitlRequests.kind, props.kind)))
      .orderBy(hitlRequests.createdAt)
      .limit(props.limit),
    mapDatabaseError,
  )

/**
 * Settle a resumed request to its terminal state — CAS answered→resumed|failed. Called in the same
 * sweep transaction as the resume, so the ledger outcome and this state flip commit atomically (a
 * crash before commit leaves the row `answered`, never half-applied).
 */
export const settleHitlRequest = (props: {
  tx: Transaction
  id: string
  status: "resumed" | "failed"
}) =>
  ResultAsync.fromPromise(
    props.tx
      .update(hitlRequests)
      .set({ status: props.status })
      .where(and(eq(hitlRequests.id, props.id), eq(hitlRequests.status, "answered")))
      .returning({ id: hitlRequests.id }),
    mapDatabaseError,
  )
