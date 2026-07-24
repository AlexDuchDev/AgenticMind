import { sql } from "drizzle-orm"
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

/**
 * Durable human-in-the-loop requests (12-Factor F7 / STANDARD Layer 5 durable-HITL invariant).
 * One row per ask that suspends an agent loop until a human answers: the agent emits `hitl_request`
 * (creating a `pending` row and returning immediately — it does NOT block the caller), the human
 * later delivers an answer via `hitl_respond` (`pending` → `answered`), and the asking agent resumes
 * by polling `hitl_get` for its own request until it reads the answer. A stale `pending` row past
 * `expiresAt` is swept to `expired` and escalated (Loop License #6). Durability is the point: the
 * request survives both a long human wait and a killed process, so work is never lost.
 *
 * SINGLE-SYSTEM scope (v1): operational/system runtime state produced by an agent loop, keyed by the
 * caller's `(requestedBy, requestId)` idempotency pair — like `assurance_runs` and `tool_audit_events`
 * it carries NO tenant column. `hitl_get` is authorized to the asking actor, but `hitl_respond` is
 * NOT tenant-scoped: a holder of the elevated `hitl:respond` scope can answer any request by id.
 * That is safe for a single-system deployment (one operator answers the engine's own requests); a
 * MULTI-TENANT HITL deployment MUST add `tenantColumn` + an RLS policy here before exposing these
 * tools across tenants (see [[agenticmind-multitenant-rls-landmine]]).
 */
const hitlRequests = pgTable(
  "hitl_requests",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Caller-supplied idempotency key (e.g. the originating tool-call id). Unique PER requester —
     * a retry with the same key returns the existing row; two DIFFERENT agents may reuse a key
     * (`call_1`) without shadowing each other. */
    requestId: text("request_id").notNull(),
    /** What kind of human decision this is: "approval", "clarification", "remediation_approval", … */
    kind: text("kind").notNull(),
    /** Lifecycle: pending → answered (a human replied) | pending → expired (deadline passed). */
    status: text("status").notNull().default("pending"),
    /** The question/context shown to the human. */
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The human's answer once delivered; null while pending. */
    response: jsonb("response"),
    /** The agent/principal that asked (owns and polls this row via hitl_get). */
    requestedBy: text("requested_by").notNull(),
    /** The human principal that answered; set on `hitl_respond`. Never equal to `requestedBy`. */
    answeredBy: text("answered_by"),
    /** Optional deadline; a pending row past this is swept to `expired` and escalated. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** When the human answered. */
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    // Idempotency is per-requester, not global: agent A's `call_1` must not shadow agent B's.
    uniqueIndex("hitl_requests_requester_request_id_uidx").on(table.requestedBy, table.requestId),
    // Serves the expiry sweep predicate (status = 'pending' AND expires_at < now()).
    index("hitl_requests_status_expiry_idx").on(table.status, table.expiresAt),
    check("hitl_requests_status_check", sql`${table.status} IN ('pending', 'answered', 'expired')`),
  ],
)

type HitlRequestInsert = typeof hitlRequests.$inferInsert
type HitlRequestSelect = typeof hitlRequests.$inferSelect

export { hitlRequests, type HitlRequestInsert, type HitlRequestSelect }
