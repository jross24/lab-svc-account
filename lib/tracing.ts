import { AsyncLocalStorage } from 'node:async_hooks';
import {
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  defaultTextMapGetter,
  defaultTextMapSetter,
  trace,
} from '@opentelemetry/api';
import type { Attributes, Context, Span, Tracer } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, TracerProvider } from '@opentelemetry/sdk-trace';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { XRayExporter } from './xray-exporter.ts';

type Env = Record<string, string | undefined>;

export interface TracingOptions {
  readonly service: string;
  readonly version: string;
  readonly exporter: SpanExporter;
  // More attributes of the resource, for example the cloud region.
  readonly resourceAttributes?: Attributes;
  // The longest time that the end of a request waits for the export of its spans.
  readonly flushTimeoutMs?: number;
  // The share of the new traces that are sampled, from 0 (none) to 1 (all). The default is 1.
  // It applies to a request that has no parent. A request with a traceparent header follows the flag of its parent.
  readonly sampleRatio?: number;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 2500;

// The name of the setting that carries the sampling ratio to the function.
export const SAMPLE_RATIO_ENV = 'TRACE_SAMPLE_RATIO';

// Reads a sampling ratio: a number from 0 to 1. The OpenTelemetry sampler turns a bad number into 0 and says nothing,
// and then a typo would switch the tracing off. So this function refuses anything else.
export function parseSampleRatio(value: string | number): number {
  const ratio = typeof value === 'number' ? value : value.trim() === '' ? Number.NaN : Number(value);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new RangeError(`The sampling ratio must be a number from 0 to 1. Got ${JSON.stringify(value)}.`);
  }
  return ratio;
}

// Traces with OpenTelemetry, and no global state of OpenTelemetry. The class holds its own provider, its own
// propagator and its own store for the active context, so a test can make as many instances as it wants.
//
// A trace crosses from one service to the next in the W3C header "traceparent". The class puts the header on a
// request to another service (fetch) and reads it from a request that it serves (serve).
// It does not use the header X-Amzn-Trace-Id. API Gateway adds a part of its own to it ("Self="), and Lambda
// starts its own trace for the function and ignores the header. A traceparent header passes API Gateway as it is.
//
// Each request ends with a flush, because Lambda freezes the function when the handler returns, and a frozen
// function cannot send its spans.
//
// The sampler is "parent based". A request with a traceparent header follows the flag of the caller: a sampled
// parent is always sampled, and a parent that is not sampled never is. A request with no parent is sampled by its
// trace ID, for the share `sampleRatio`. A span that is not sampled is not recorded, and the flush has nothing to export.
// The trace ID and the header traceparent exist in both cases, so the log lines of all services still share the ID.
export class Tracing {
  readonly enabled: boolean;
  readonly #tracer: Tracer;
  readonly #provider: TracerProvider | undefined;
  readonly #flushTimeoutMs: number;
  readonly #propagator = new W3CTraceContextPropagator();
  readonly #active = new AsyncLocalStorage<Context>();

  private constructor(tracer: Tracer, provider: TracerProvider | undefined, flushTimeoutMs: number) {
    this.#tracer = tracer;
    this.#provider = provider;
    this.#flushTimeoutMs = flushTimeoutMs;
    this.enabled = provider !== undefined;
  }

  static create(options: TracingOptions): Tracing {
    const sampleRatio = parseSampleRatio(options.sampleRatio ?? 1);
    const provider = new TracerProvider({
      resource: resourceFromAttributes({
        'service.name': options.service,
        'service.version': options.version,
        ...options.resourceAttributes,
      }),
      // X-Ray wants a trace ID that starts with the time. The generator of X-Ray makes such an ID.
      idGenerator: new AWSXRayIdGenerator(),
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRatio) }),
      // The spans of one request leave in one batch, when the request ends. The long delay keeps the timer quiet.
      spanProcessors: [new BatchSpanProcessor({ exporter: options.exporter, scheduledDelayMillis: 60_000, maxExportBatchSize: 64 })],
    });
    return new Tracing(provider.getTracer('lab', options.version), provider, options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS);
  }

  // A tracing that records nothing: a laptop, a unit test, or a function with TRACING=off.
  static disabled(): Tracing {
    return new Tracing(trace.getTracer('lab'), undefined, DEFAULT_FLUSH_TIMEOUT_MS);
  }

  // Runs `run` inside the server span of one request. The parent of the span comes from the header traceparent,
  // when the caller sent one. The method ends the span and flushes, also when `run` throws.
  async serve<T>(
    input: { readonly name: string; readonly headers?: Readonly<Record<string, string | undefined>> | undefined; readonly attributes?: Attributes },
    run: (span: Span) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) return run(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
    const parent = this.#propagator.extract(ROOT_CONTEXT, input.headers ?? {}, defaultTextMapGetter);
    const span = this.#tracer.startSpan(input.name, { kind: SpanKind.SERVER, attributes: input.attributes }, parent);
    try {
      return await this.#active.run(trace.setSpan(parent, span), () => run(span));
    } catch (caught) {
      span.recordException(caught instanceof Error ? caught : String(caught));
      span.setStatus({ code: SpanStatusCode.ERROR, message: caught instanceof Error ? caught.message : 'unknown error' });
      throw caught;
    } finally {
      span.end();
      await this.flush();
    }
  }

  // Sends a request to another service as a client span, and puts the header traceparent on it.
  // Call it AFTER the signature of the request: the signature does not cover the new header, and API Gateway
  // checks only the headers that the signature lists. Outside of `serve` the request goes on with no change.
  async fetch<I extends { headers?: Record<string, string> | undefined }>(
    send: (url: string, init: I) => Promise<Response>,
    url: string,
    init: I,
  ): Promise<Response> {
    const parent = this.#active.getStore();
    if (!this.enabled || !parent) return send(url, init);

    const target = new URL(url);
    const method = (init as { method?: string }).method ?? 'GET';
    const span = this.#tracer.startSpan(
      `${method} ${target.host}`,
      {
        kind: SpanKind.CLIENT,
        // The URL without user info and without query: neither may enter a trace.
        attributes: { 'http.request.method': method, 'server.address': target.hostname, 'url.full': `${target.origin}${target.pathname}` },
      },
      parent,
    );
    const headers: Record<string, string> = { ...init.headers };
    this.#propagator.inject(trace.setSpan(parent, span), headers, defaultTextMapSetter);
    try {
      const response = await send(url, { ...init, headers });
      span.setAttribute('http.response.status_code', response.status);
      if (response.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
      return response;
    } catch (caught) {
      span.recordException(caught instanceof Error ? caught : String(caught));
      span.setStatus({ code: SpanStatusCode.ERROR, message: caught instanceof Error ? caught.message : 'unknown error' });
      throw caught;
    } finally {
      span.end();
    }
  }

  // Sends the finished spans now. It never throws: a lost span must not fail a request.
  async flush(): Promise<void> {
    if (!this.#provider) return;
    try {
      await this.#provider.forceFlush({ timeoutMillis: this.#flushTimeoutMs });
    } catch {
      // The exporter has logged the reason, or the flush ran out of time. The request goes on.
    }
  }
}

// The trace ID in the form that X-Ray and CloudWatch show: 1-<8 hex digits>-<24 hex digits>.
// A log line with this ID leads to the trace in the console and in `aws xray batch-get-traces`.
export function xrayTraceId(span: Span): string | undefined {
  const context = span.spanContext();
  if (!trace.isSpanContextValid(context)) return undefined;
  return `1-${context.traceId.slice(0, 8)}-${context.traceId.slice(8)}`;
}

function sampleRatioOf(env: Env): number {
  const text = env[SAMPLE_RATIO_ENV];
  if (text === undefined || text === '') return 1;
  try {
    return parseSampleRatio(text);
  } catch {
    return 1;
  }
}

// Tracing for a function in Lambda. Outside Lambda there is no function name, so the tracing is off.
// The setting TRACING=off switches it off in Lambda too. The setting TRACE_SAMPLE_RATIO (0 to 1) sets the share of
// new traces that are sampled. When it is missing or not valid, the function samples all requests, because a trace
// that is lost costs more than a trace that is not needed. The CDK app refuses a value that is not valid (function-defaults.ts).
export function createDefaultTracing(service: string, env: Env = process.env): Tracing {
  if (!env.AWS_LAMBDA_FUNCTION_NAME || env.TRACING === 'off') return Tracing.disabled();
  const resourceAttributes: Attributes = { 'cloud.provider': 'aws', 'faas.name': env.AWS_LAMBDA_FUNCTION_NAME };
  if (env.AWS_REGION) resourceAttributes['cloud.region'] = env.AWS_REGION;
  return Tracing.create({
    sampleRatio: sampleRatioOf(env),
    service,
    version: env.VERSION ?? 'unknown',
    exporter: new XRayExporter(),
    resourceAttributes,
  });
}

// One tracing for the whole function. The wrapper of the handler makes it (see instrument.ts),
// and the code that calls another service reads it with currentTracing.
let shared: Tracing | undefined;

export function tracingFor(service: string): Tracing {
  shared ??= createDefaultTracing(service);
  return shared;
}

export function currentTracing(): Tracing {
  return shared ?? Tracing.disabled();
}
