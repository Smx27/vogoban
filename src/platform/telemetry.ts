import { context, propagation, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createLogger, type Logger } from "../log.ts";

let provider: BasicTracerProvider | null = null;

/** OpenTelemetry tracing exported over OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is configured; spans are no-ops otherwise. */
export function initTracing(serviceName: string, version: string, endpoint: string | null) {
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  if (!endpoint || provider) return;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName, [ATTR_SERVICE_VERSION]: version }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, "")}/v1/traces` }), { scheduledDelayMillis: 1000 })],
  });
  trace.setGlobalTracerProvider(provider);
}

export async function shutdownTracing() {
  await provider?.forceFlush().catch(() => undefined);
  await provider?.shutdown().catch(() => undefined);
}

export const tracer = () => trace.getTracer("vogoban");

export async function inSpan<T>(name: string, attributes: Record<string, string | number | boolean | undefined>, fn: (span: Span) => Promise<T>, parent?: string | null): Promise<T> {
  const ctx = parent ? propagation.extract(context.active(), { traceparent: parent }) : context.active();
  return tracer().startActiveSpan(name, { attributes: Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean> }, ctx, async (span) => {
    try {
      const out = await fn(span);
      span.end();
      return out;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      span.end();
      throw error;
    }
  });
}

/** W3C traceparent of the active span, persisted on jobs so worker spans join the API trace. */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

export const traceIdOf = (span: Span | undefined) => {
  const id = span?.spanContext().traceId;
  return id && !/^0+$/.test(id) ? id : null;
};

type Labels = Record<string, string>;
const key = (labels: Labels) => JSON.stringify(Object.entries(labels).sort());

class Counter {
  readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    const cur = this.values.get(k) ?? { labels, value: 0 };
    cur.value += by;
    this.values.set(k, cur);
  }
}

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800];
class Histogram {
  readonly values = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string) {}
  observe(labels: Labels, seconds: number) {
    const k = key(labels);
    const cur = this.values.get(k) ?? { labels, counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => seconds <= b && cur.counts[i]!++);
    cur.sum += seconds;
    cur.count++;
    this.values.set(k, cur);
  }
}

class Gauge {
  readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string) {}
  set(labels: Labels, value: number) {
    this.values.set(key(labels), { labels, value });
  }
}

const fmt = (labels: Labels) => {
  const e = Object.entries(labels);
  return e.length ? `{${e.map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, "_")}"`).join(",")}}` : "";
};

/** Process metrics in the Prometheus exposition format (scraped from /metrics; OpenTelemetry collectors scrape it too). */
export const metrics = {
  httpRequests: new Counter("vogoban_http_requests_total", "HTTP requests by route, method and status"),
  httpDuration: new Histogram("vogoban_http_request_duration_seconds", "HTTP request latency by route"),
  rateLimited: new Counter("vogoban_rate_limited_total", "Requests rejected by rate limiting by category"),
  jobs: new Counter("vogoban_jobs_total", "Jobs finished by type and status"),
  jobDuration: new Histogram("vogoban_job_duration_seconds", "Job execution time by type"),
  analysisEntities: new Gauge("vogoban_analysis_graph_size", "Entities and relationships of the latest analysis per tenant/repository"),
  aiRequests: new Counter("vogoban_ai_requests_total", "AI questions by tenant, mode and status"),
  aiTokens: new Counter("vogoban_ai_tokens_total", "LLM tokens by tenant, provider, model and direction"),
  aiLatency: new Histogram("vogoban_ai_latency_seconds", "AI answer latency by mode"),
  mcpCalls: new Counter("vogoban_mcp_calls_total", "MCP requests by method and outcome"),
  workerHeartbeat: new Gauge("vogoban_worker_last_heartbeat_seconds", "Unix time of each worker's last heartbeat"),
  queueDepth: new Gauge("vogoban_jobs_queued", "Queued jobs (sampled by readiness checks)"),
  render(): string {
    const out: string[] = [];
    for (const m of [this.httpRequests, this.rateLimited, this.jobs, this.aiRequests, this.aiTokens, this.mcpCalls]) {
      out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} counter`);
      for (const v of m.values.values()) out.push(`${m.name}${fmt(v.labels)} ${v.value}`);
    }
    for (const m of [this.analysisEntities, this.workerHeartbeat, this.queueDepth]) {
      out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} gauge`);
      for (const v of m.values.values()) out.push(`${m.name}${fmt(v.labels)} ${v.value}`);
    }
    for (const m of [this.httpDuration, this.jobDuration, this.aiLatency]) {
      out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} histogram`);
      for (const v of m.values.values()) {
        BUCKETS.forEach((b, i) => out.push(`${m.name}_bucket${fmt({ ...v.labels, le: String(b) })} ${v.counts[i]}`));
        out.push(`${m.name}_bucket${fmt({ ...v.labels, le: "+Inf" })} ${v.count}`, `${m.name}_sum${fmt(v.labels)} ${v.sum}`, `${m.name}_count${fmt(v.labels)} ${v.count}`);
      }
    }
    return `${out.join("\n")}\n`;
  },
};

/** Structured JSON logs on stderr; every record carries the component and, when known, correlation and trace ids. */
export function platformLogger(component: string, level = process.env.VOGOBAN_LOG_LEVEL ?? "info"): Logger {
  return createLogger({ level, json: process.env.VOGOBAN_LOG_FORMAT !== "text", base: { component } });
}
