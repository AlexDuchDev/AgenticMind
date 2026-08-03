/**
 * OpenTelemetry instrumentation seam (Agentic Product Standard — Layer 6:
 * "instrument via OpenInference / OpenLLMetry so you can swap vendors without
 * re-instrumenting"). This module depends ONLY on `@opentelemetry/api`, which is
 * a no-op until a TracerProvider is registered by the host process. So the
 * library is always instrumented at zero cost; an operator turns on export by
 * registering an exporter (see apps/server/src/tracing.ts).
 *
 * Attributes follow the OpenInference semantic conventions recognized by
 * Phoenix / Langfuse / LangSmith, so the why-trace lands in any of them.
 */

import type { Span } from "@opentelemetry/api"

import { SpanStatusCode, trace } from "@opentelemetry/api"

export const tracer = trace.getTracer("agenticmind")

/** OpenInference span kinds (subset used by the knowledge pipeline). */
export const SpanKind = {
  CHAIN: "CHAIN",
  RETRIEVER: "RETRIEVER",
  LLM: "LLM",
} as const
export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind]

/** OpenInference + AgenticMind span attribute keys. */
export const Attr = {
  SPAN_KIND: "openinference.span.kind",
  INPUT_VALUE: "input.value",
  OUTPUT_VALUE: "output.value",
  LLM_MODEL: "llm.model_name",
  RETRIEVAL_DOC_COUNT: "retrieval.documents.count",
  SERVED_BY: "agenticmind.served_by",
  CITATION_COUNT: "agenticmind.citation_count",
  RETRIEVAL_MS: "agenticmind.retrieval_ms",
  GENERATION_MS: "agenticmind.generation_ms",
  GROUNDEDNESS: "agenticmind.groundedness",
  UNSUPPORTED_CLAIM_COUNT: "agenticmind.unsupported_claim_count",
  ABSTAINED: "agenticmind.abstained",
  // Cost / FinOps (Layer 9): per-call token usage, OpenInference conventions.
  LLM_TOKEN_PROMPT: "llm.token_count.prompt",
  LLM_TOKEN_COMPLETION: "llm.token_count.completion",
  LLM_TOKEN_TOTAL: "llm.token_count.total",
  // OTel GenAI semantic conventions (vendor-neutral): agent attribution on the
  // root span, so any OTLP backend (Phoenix / Langfuse / AgenticPerformance)
  // attributes the why-trace to this agent. String literals, not the semconv
  // package, to avoid a new dependency.
  GEN_AI_OPERATION_NAME: "gen_ai.operation.name",
  GEN_AI_AGENT_ID: "gen_ai.agent.id",
  GEN_AI_AGENT_NAME: "gen_ai.agent.name",
} as const

/** OTel GenAI operation value for an agent invocation (the root span's op). */
export const GEN_AI_INVOKE_AGENT = "invoke_agent"
/** This engine's agent name, stamped on the root agent span. */
export const AGENT_NAME = "AgenticMind"

/**
 * Resolves this agent's id for GenAI attribution from the deployment env,
 * OTEL_SERVICE_NAME → AGENT_ID → "agenticmind". Read at span time so the value
 * tracks the process the trace is emitted from.
 */
export const resolveAgentId = (): string =>
  // oxlint-disable-next-line node/no-process-env
  process.env.OTEL_SERVICE_NAME ?? process.env.AGENT_ID ?? "agenticmind"

/**
 * Stamps the OTel GenAI agent attributes (operation = invoke_agent, agent
 * id/name) on the given span, so any OTLP backend attributes the trace to this
 * agent. A no-op unless the span is recording (i.e. an exporter is registered),
 * so it is safe to call unconditionally on the hot path. Attaches to the root
 * span only — nothing sets gen_ai.operation.name upstream, so the set is direct.
 */
export const setAgentAttributes = (span: Span): void => {
  if (!span.isRecording()) {
    return
  }
  span.setAttribute(Attr.GEN_AI_OPERATION_NAME, GEN_AI_INVOKE_AGENT)
  span.setAttribute(Attr.GEN_AI_AGENT_ID, resolveAgentId())
  span.setAttribute(Attr.GEN_AI_AGENT_NAME, AGENT_NAME)
}

/** Truncate attribute values so a span never carries an unbounded payload. */
const cap = (s: string, max = 2000): string => (s.length <= max ? s : `${s.slice(0, max)}…`)

/**
 * Runs `fn` inside an active span of the given OpenInference kind, recording
 * exceptions and ending the span. The span is a no-op unless an exporter is
 * registered, so this is safe to call unconditionally on the hot path.
 */
export const withSpan = async <T>(
  name: string,
  kind: SpanKind,
  fn: (span: Span) => Promise<T>,
): Promise<T> =>
  tracer.startActiveSpan(name, async (span) => {
    span.setAttribute(Attr.SPAN_KIND, kind)
    try {
      return await fn(span)
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)))
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw error
    } finally {
      span.end()
    }
  })

/**
 * Emits an already-finished child span with explicit start/end (epoch ms) under
 * the current active span. For instrumenting a phase that already completed
 * (timed via Date.now()) without restructuring control flow — a no-op unless an
 * exporter is registered.
 */
export const recordChildSpan = (
  name: string,
  kind: SpanKind,
  startMs: number,
  endMs: number,
  attributes?: Record<string, string | number | boolean>,
): void => {
  const span = tracer.startSpan(name, { startTime: startMs })
  span.setAttribute(Attr.SPAN_KIND, kind)
  if (attributes !== undefined) {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value)
    }
  }
  span.end(endMs)
}

/** Sets an input.value attribute (capped). */
export const setInput = (span: Span, value: string): void => {
  span.setAttribute(Attr.INPUT_VALUE, cap(value))
}

/** Sets an output.value attribute (capped). */
export const setOutput = (span: Span, value: string): void => {
  span.setAttribute(Attr.OUTPUT_VALUE, cap(value))
}
