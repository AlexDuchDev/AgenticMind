// oxlint-disable node/no-process-env
import type { Span } from "@opentelemetry/api"

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import { AGENT_NAME, Attr, resolveAgentId, setAgentAttributes } from "./trace"

const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
const tracer = provider.getTracer("test")

const savedEnv = {
  OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME,
  AGENT_ID: process.env.AGENT_ID,
}

afterEach(() => {
  exporter.reset()
  process.env.OTEL_SERVICE_NAME = savedEnv.OTEL_SERVICE_NAME
  process.env.AGENT_ID = savedEnv.AGENT_ID
})

afterAll(async () => {
  await provider.shutdown()
})

describe("resolveAgentId", () => {
  it("prefers OTEL_SERVICE_NAME, then AGENT_ID, then the default", () => {
    process.env.OTEL_SERVICE_NAME = "svc-name"
    process.env.AGENT_ID = "agent-id"
    expect(resolveAgentId()).toBe("svc-name")

    delete process.env.OTEL_SERVICE_NAME
    expect(resolveAgentId()).toBe("agent-id")

    delete process.env.AGENT_ID
    expect(resolveAgentId()).toBe("agenticmind")
  })
})

describe("setAgentAttributes", () => {
  it("stamps the OTel GenAI agent attributes on a recording root span", async () => {
    process.env.OTEL_SERVICE_NAME = "agenticmind"
    delete process.env.AGENT_ID

    const span = tracer.startSpan("knowledge.ask")
    setAgentAttributes(span)
    span.end()
    await provider.forceFlush()

    const [finished] = exporter.getFinishedSpans()
    expect(finished?.attributes[Attr.GEN_AI_OPERATION_NAME]).toBe("invoke_agent")
    expect(finished?.attributes[Attr.GEN_AI_AGENT_ID]).toBe("agenticmind")
    expect(finished?.attributes[Attr.GEN_AI_AGENT_NAME]).toBe(AGENT_NAME)
  })

  it("is a no-op on a non-recording span (tracing disabled)", () => {
    const setAttribute = vi.fn()
    const span = { isRecording: () => false, setAttribute } as unknown as Span
    setAgentAttributes(span)
    expect(setAttribute).not.toHaveBeenCalled()
  })
})
