/**
 * Remediation as the first INTERNAL consumer of the durable-HITL engine (STANDARD Layer 5 / Loop
 * License #6). An L3 remediation that passed the judge does NOT auto-apply: it suspends on a durable
 * hitl_request (`requestRemediationApproval`), a human answers via hitl_respond, and the hitl-resume
 * worker drives that answer through the actor-enforced ledger (`resumeRemediation`): approve → apply,
 * or decline (fail-closed).
 *
 * `applyRemediation` only RECORDS the reversible ledger transition — the external config write is a
 * separate integration and, per FR-12.2, is never triggered by the loop. The ledger itself is
 * in-memory in @agenticmind/assurance (no DB table), so the durable record here is the hitl_request
 * lifecycle (answered → resumed|failed) plus the logged outcome, not the applied ledger entry.
 */
import type { CoreReport } from "@agenticmind/assurance/gap/ingest"
import type { AssuranceNotifier } from "@agenticmind/assurance/notify/channel"
import type { RemediationJudge } from "@agenticmind/assurance/remediate/judge"
import type { AppliedEdit, RemediationLedgerEntry } from "@agenticmind/assurance/remediate/ledger"
import type { Transaction } from "@agenticmind/shared/database/client"

import { consoleNotifier } from "@agenticmind/assurance/notify/channel"
import { formatApprovalRequest } from "@agenticmind/assurance/notify/format"
import {
  applyRemediation,
  approveRemediation,
  declineRemediation,
  openRemediation,
} from "@agenticmind/assurance/remediate/apply"
import { gateProposal } from "@agenticmind/assurance/remediate/judge"
import { triageFindings } from "@agenticmind/assurance/remediate/triage"
import { createHitlRequest } from "@agenticmind/shared/database/query/hitl/requests"

/**
 * The hitl_request kind that routes to this resume handler. The `internal:` prefix reserves it from
 * agent-facing `hitl_request` (which rejects `internal:` kinds), so an agent cannot forge a
 * remediation-approval row for the sweep to pick up.
 */
export const REMEDIATION_KIND = "internal:remediation_approval"

/** What requestRemediationApproval stores in the hitl payload so the resume has all it needs. */
type RemediationPayload = {
  entry: RemediationLedgerEntry
  edits: readonly AppliedEdit[]
}

/**
 * Suspend an L3 remediation on a durable human approval. Persists the pending ledger entry + its
 * concrete edits (the ledger keeps `edits` empty until applied, so we carry them ourselves) and
 * notifies a human with a payload-free approval request. Idempotent on the entry id.
 *
 * Called by `proposeRemediations` (the L3 producer, wired into the assurance-drift sweep): on a fed
 * AAL Core report with attack findings it triages → gates → suspends here. The scheduled sweep feeds
 * an EMPTY report (no attacks ⇒ no requests), so this activates only when a deployment feeds a real
 * `aal scan` report — the worker never runs the scan itself (FR-12.2).
 */
export const requestRemediationApproval = async (
  props: {
    tx: Transaction
    entry: RemediationLedgerEntry
    edits: readonly AppliedEdit[]
    requestedBy: string
  },
  notify: AssuranceNotifier = consoleNotifier,
): Promise<string> => {
  if (props.entry.state !== "pending_approval") {
    throw new Error(
      `requestRemediationApproval: entry ${props.entry.id} is '${props.entry.state}', not 'pending_approval'`,
    )
  }
  const payload: RemediationPayload = { entry: props.entry, edits: props.edits }
  const created = await createHitlRequest({
    tx: props.tx,
    request: {
      requestId: props.entry.id, // "rem:<proposalId>" — idempotent per requester
      kind: REMEDIATION_KIND,
      requestedBy: props.requestedBy,
      payload,
    },
  })
  if (created.isErr()) {
    throw new Error(`requestRemediationApproval: ${created.error.message}`)
  }
  // Give the human enough to APPROVE informedly — the judge's rationale + which structural surfaces
  // change (op + path). These are payload-free DESCRIPTIONS (not raw evidence/secrets — they already
  // go into the judge prompt), so enriching the base approval notification is safe and closes the
  // blind-rubber-stamp gap. A notifier failure must not fail the request — it is durable.
  const base = formatApprovalRequest(props.entry)
  const editList = props.edits.map((edit) => `${edit.op} ${edit.path}`).join(", ")
  const rationale = props.entry.verdict?.rationale ?? ""
  try {
    await notify({
      ...base,
      body:
        rationale === ""
          ? `${base.body} Edits: ${editList}.`
          : `${base.body} Judge: ${rationale}. Edits: ${editList}.`,
      context: {
        ...base.context,
        edits: editList,
        ...(rationale === "" ? {} : { rationale }),
      },
    })
  } catch (error: unknown) {
    console.error("[HITL_REMEDIATION] notifier failed:", error)
  }
  return created.value
}

const isRemediationPayload = (value: unknown): value is RemediationPayload =>
  value !== null &&
  typeof value === "object" &&
  "entry" in value &&
  "edits" in value &&
  Array.isArray((value as { edits: unknown }).edits)

/**
 * The exact answers that count as approval. Anything else — a nuanced or ambiguous free-text reply,
 * a missing/typed-wrong answer — fails closed to a decline, so a destructive fix never lands on a
 * fuzzy "yes". A prefix match ("approve? actually no") would be a false-approval hole; this is exact.
 */
const APPROVAL_ANSWERS: ReadonlySet<string> = new Set(["approve", "approved"])

/** True only when the human's answer is an EXACT approval token; anything else declines. */
const isApproval = (response: unknown): boolean => {
  if (response !== null && typeof response === "object" && "answer" in response) {
    const answer = (response as { answer: unknown }).answer
    if (typeof answer === "string") {
      return APPROVAL_ANSWERS.has(answer.trim().toLowerCase())
    }
  }
  return false
}

/**
 * Resume an answered remediation request: rehydrate the entry + edits and apply the human's decision
 * through the actor-enforced ledger. Approve → apply (records the reversible transition); anything
 * that is not an explicit approval → decline. Throws on a malformed payload or an illegal ledger
 * transition, so the sweep settles that row `failed` (terminal, not retried forever).
 */
export const resumeRemediation = (
  row: { id: string; payload: unknown; response: unknown; answeredBy: string | null },
  at: string,
): { outcome: string } => {
  if (!isRemediationPayload(row.payload)) {
    throw new Error(`resumeRemediation: malformed payload on ${row.id}`)
  }
  const { entry, edits } = row.payload
  const approver = row.answeredBy ?? "unknown"

  if (!isApproval(row.response)) {
    const declined = declineRemediation(entry, approver, at)
    if (declined.isErr()) {
      throw new Error(`resumeRemediation: decline failed: ${declined.error.message}`)
    }
    return { outcome: `declined by hitl:${approver}` }
  }

  const approved = approveRemediation(entry, approver, at)
  if (approved.isErr()) {
    throw new Error(`resumeRemediation: approve failed: ${approved.error.message}`)
  }
  // INVARIANT: applyRemediation only RECORDS a ledger transition (no external I/O). At-most-once
  // holds because the sweep's select→resume→settle commit atomically under one advisory lock. Do NOT
  // add a non-transactional external effect (a real config write) on this path without persisting an
  // idempotency key (entry.id) in the SAME transaction — a crash between the effect and settle would
  // re-apply on the next tick. This is a hard gate, not a preference.
  const applied = applyRemediation(approved.value, edits, at)
  if (applied.isErr()) {
    throw new Error(`resumeRemediation: apply refused: ${applied.error.message}`)
  }
  return {
    outcome: `approved by hitl:${approver}; recorded ledger apply of ${edits.length} edit(s)`,
  }
}

/** The system principal that ASKS for an auto-proposed remediation — never a human, so the
 * `ne(requestedBy, answeredBy)` self-answer belt always holds against the human who approves. */
export const REMEDIATION_REQUESTER = "system:assurance-remediation"

/**
 * L3 producer — auto-PROPOSE from a fed AAL Core report, human-APPROVE (STANDARD Layer 5, Loop
 * License). Triage the report's failed-attack classes into structural fix proposals, gate each
 * through the Cycle-of-Trust guard + the fail-closed judge, and — for a `supported` proposal only —
 * suspend it on a durable human approval (requestRemediationApproval). Nothing applies without a
 * human; the worker never runs the scan itself (FR-12.2), so the report is an injected input (an
 * empty report yields zero proposals and zero judge calls — the cheap scheduled default).
 */
export const proposeRemediations = async (
  props: {
    tx: Transaction
    report: CoreReport
    judge: RemediationJudge
    requestedBy?: string
  },
  notify: AssuranceNotifier = consoleNotifier,
): Promise<{ proposed: number; requested: number }> => {
  const proposals = triageFindings(props.report)
  const requestedBy = props.requestedBy ?? REMEDIATION_REQUESTER
  const at = new Date().toISOString()
  let requested = 0
  for (const proposal of proposals) {
    const gate = await gateProposal(proposal, props.judge)
    if (gate.decision !== "pending_approval") {
      // guard_rejected / judge_rejected — terminal (fail-closed); nothing to put to a human.
      continue
    }
    const entry = openRemediation(proposal, gate, at)
    // The ledger keeps `edits` empty until applied; carry the proposal's structural edits (path/op)
    // so the resume can re-check + apply them. before/after are unmaterialised until an external write.
    const edits: AppliedEdit[] = proposal.edits.map((edit) => {
      return { path: edit.path, op: edit.op, before: null, after: null }
    })
    // Idempotent on requestId (= entry.id = "rem:fix:<class>") per requester — so a persistent finding
    // is put to a human ONCE per requester, not re-nagged every sweep. Deliberate: once a human has
    // answered (approved OR declined), the same class-finding does not resurrect a request.
    await requestRemediationApproval({ tx: props.tx, entry, edits, requestedBy }, notify)
    requested += 1
  }
  return { proposed: proposals.length, requested }
}
