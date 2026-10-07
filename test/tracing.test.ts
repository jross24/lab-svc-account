import { describe, expect, it } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { Tracing, createDefaultTracing, xrayTraceId } from '../lib/tracing.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE}-${PARENT}-01`;

function setup(exporter: SpanExporter = new InMemorySpanExporter()) {
  const tracing = Tracing.create({ service: 'catalogue', version: '1.2.3', exporter });
  const spans = (): ReadableSpan[] => (exporter as InMemorySpanExporter).getFinishedSpans();
  return { tracing, spans };
}

function byName(spans: ReadableSpan[], name: string): ReadableSpan {
  const found = spans.find((span) => span.name === name);
  expect(found, name).toBeDefined();
  return found as ReadableSpan;
}

describe('Tracing.serve', () => {
  it('records one server span with the name and the attributes, and exports it before it returns', async () => {
    const { tracing, spans } = setup();
    const result = await tracing.serve({ name: 'GET /products', attributes: { 'http.route': '/products' } }, () =>
      Promise.resolve('answer'),
    );
    expect(result).toBe('answer');
    expect(spans()).toHaveLength(1);
    expect(spans()[0]).toMatchObject({ name: 'GET /products', kind: SpanKind.SERVER, ended: true });
    expect(spans()[0]?.attributes['http.route']).toBe('/products');
  });

  it('names the service, the version and the cloud in the resource of the span', async () => {
    const { tracing, spans } = setup();
    await tracing.serve({ name: 'x' }, () => Promise.resolve());
    expect(spans()[0]?.resource.attributes).toMatchObject({ 'service.name': 'catalogue', 'service.version': '1.2.3' });
  });

  it('starts a new trace when the request has no traceparent header, with a trace ID that X-Ray accepts', async () => {
    const { tracing, spans } = setup();
    await tracing.serve({ name: 'x', headers: {} }, () => Promise.resolve());
    const span = spans()[0] as ReadableSpan;
    expect(span.parentSpanContext).toBeUndefined();
    // An X-Ray trace ID starts with the time in seconds as 8 hex digits. X-Ray drops a trace with another start.
    const seconds = parseInt(span.spanContext().traceId.slice(0, 8), 16);
    expect(Math.abs(seconds - Date.now() / 1000)).toBeLessThan(60);
    expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('continues the trace of the traceparent header: same trace ID, the caller span is the parent', async () => {
    const { tracing, spans } = setup();
    await tracing.serve({ name: 'x', headers: { traceparent: TRACEPARENT } }, () => Promise.resolve());
    const span = spans()[0] as ReadableSpan;
    expect(span.spanContext().traceId).toBe(TRACE);
    expect(span.parentSpanContext?.spanId).toBe(PARENT);
  });

  it('ignores a traceparent header that is not valid', async () => {
    const { tracing, spans } = setup();
    await tracing.serve({ name: 'x', headers: { traceparent: 'garbage' } }, () => Promise.resolve());
    expect(spans()[0]?.parentSpanContext).toBeUndefined();
  });

  it('marks the span as an error, records the exception and throws the same error again', async () => {
    const { tracing, spans } = setup();
    const failure = new Error('boom');
    await expect(tracing.serve({ name: 'x' }, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(spans()[0]?.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'boom' });
    expect(spans()[0]?.events.map((event) => event.name)).toContain('exception');
  });

  it('exports also when the callback throws', async () => {
    const { tracing, spans } = setup();
    await expect(tracing.serve({ name: 'x' }, () => Promise.reject(new Error('boom')))).rejects.toThrow();
    expect(spans()).toHaveLength(1);
  });

  it('lets the callback change the span', async () => {
    const { tracing, spans } = setup();
    await tracing.serve({ name: 'x' }, (span) => {
      span.setAttribute('http.response.status_code', 502);
      span.setStatus({ code: SpanStatusCode.ERROR });
      return Promise.resolve();
    });
    expect(spans()[0]?.attributes['http.response.status_code']).toBe(502);
    expect(spans()[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('Tracing.fetch', () => {
  type Init = { headers?: Record<string, string>; signal?: AbortSignal };
  const answer = (status: number) => (): Promise<Response> => Promise.resolve(new Response('{}', { status }));

  function recordingSend(status = 200) {
    const seen: { url: string; init: Init }[] = [];
    const send = (url: string, init: Init): Promise<Response> => {
      seen.push({ url, init });
      return answer(status)();
    };
    return { seen, send };
  }

  it('records a client span as a child of the server span, and sends its traceparent on', async () => {
    const { tracing, spans } = setup();
    const { seen, send } = recordingSend();
    await tracing.serve({ name: 'GET /products', headers: { traceparent: TRACEPARENT } }, () =>
      tracing.fetch(send, 'https://abc123.execute-api.eu-west-2.amazonaws.com/items?secret=1', { headers: { authorization: 'signed' } }),
    );
    const server = byName(spans(), 'GET /products');
    const client = byName(spans(), 'GET abc123.execute-api.eu-west-2.amazonaws.com');
    expect(client.kind).toBe(SpanKind.CLIENT);
    expect(client.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(client.spanContext().traceId).toBe(TRACE);
    expect(seen[0]?.init.headers?.traceparent).toBe(`00-${TRACE}-${client.spanContext().spanId}-01`);
  });

  it('keeps the headers of the caller and does not change the object of the caller', async () => {
    const { tracing } = setup();
    const { seen, send } = recordingSend();
    const init: Init = { headers: { authorization: 'signed', 'x-amz-date': '20260101T000000Z' } };
    await tracing.serve({ name: 'x' }, () => tracing.fetch(send, 'https://example.com/a', init));
    expect(seen[0]?.init.headers).toMatchObject({ authorization: 'signed', 'x-amz-date': '20260101T000000Z' });
    expect(init.headers).not.toHaveProperty('traceparent');
  });

  it('passes the other fields of the init on', async () => {
    const { tracing } = setup();
    const { seen, send } = recordingSend();
    const signal = AbortSignal.timeout(1000);
    await tracing.serve({ name: 'x' }, () => tracing.fetch(send, 'https://example.com/a', { signal }));
    expect(seen[0]?.init.signal).toBe(signal);
  });

  it('records the status, and marks a status of 400 or more as an error', async () => {
    const { tracing, spans } = setup();
    await tracing.serve({ name: 'x' }, async () => {
      await tracing.fetch(recordingSend(200).send, 'https://ok.example.com/a', {});
      await tracing.fetch(recordingSend(503).send, 'https://bad.example.com/a', {});
    });
    expect(byName(spans(), 'GET ok.example.com').attributes['http.response.status_code']).toBe(200);
    expect(byName(spans(), 'GET ok.example.com').status.code).toBe(SpanStatusCode.UNSET);
    expect(byName(spans(), 'GET bad.example.com').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('records a network error on the span and throws it again', async () => {
    const { tracing, spans } = setup();
    const failure = new Error('socket hang up');
    await tracing.serve({ name: 'x' }, async () => {
      await expect(tracing.fetch(() => Promise.reject(failure), 'https://down.example.com/a', {})).rejects.toBe(failure);
    });
    expect(byName(spans(), 'GET down.example.com').status).toMatchObject({ code: SpanStatusCode.ERROR });
  });

  it('does not put the query string or the user info of the URL into the span', async () => {
    const { tracing, spans } = setup();
    await tracing.serve({ name: 'x' }, () =>
      tracing.fetch(recordingSend().send, 'https://user:pass@example.com/path?token=abc', {}),
    );
    const client = byName(spans(), 'GET example.com');
    expect(JSON.stringify(client.attributes)).not.toMatch(/token|pass|abc/);
    expect(client.attributes['url.full']).toBe('https://example.com/path');
  });

  it('does not trace a request that has no server span around it', async () => {
    const { tracing, spans } = setup();
    const { seen, send } = recordingSend();
    await tracing.fetch(send, 'https://example.com/a', { headers: { a: 'b' } });
    expect(spans()).toHaveLength(0);
    expect(seen[0]?.init.headers).toEqual({ a: 'b' });
  });

  it('keeps two requests apart, also when they run at the same time', async () => {
    const { tracing, spans } = setup();
    const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const call = (trace: string, wait: number) =>
      tracing.serve({ name: `request ${trace}`, headers: { traceparent: `00-${trace.repeat(32)}-${PARENT}-01` } }, async () => {
        await pause(wait);
        const { send, seen } = recordingSend();
        await tracing.fetch(send, `https://${trace}.example.com/a`, {});
        return seen[0]?.init.headers?.traceparent;
      });
    const [one, two] = await Promise.all([call('a', 20), call('b', 1)]);
    expect(one).toContain(`00-${'a'.repeat(32)}-`);
    expect(two).toContain(`00-${'b'.repeat(32)}-`);
    expect(byName(spans(), 'GET a.example.com').spanContext().traceId).toBe('a'.repeat(32));
    expect(byName(spans(), 'GET b.example.com').spanContext().traceId).toBe('b'.repeat(32));
  });
});

describe('Tracing.disabled', () => {
  it('runs the callback, records nothing and has no trace ID', async () => {
    const tracing = Tracing.disabled();
    let traceId: string | undefined = 'unset';
    const result = await tracing.serve({ name: 'x', headers: { traceparent: TRACEPARENT } }, (span) => {
      traceId = xrayTraceId(span);
      return Promise.resolve(7);
    });
    expect(result).toBe(7);
    expect(traceId).toBeUndefined();
    expect(tracing.enabled).toBe(false);
  });

  it('sends a request on unchanged', async () => {
    const tracing = Tracing.disabled();
    const seen: unknown[] = [];
    const init = { headers: { a: 'b' } };
    await tracing.serve({ name: 'x' }, () =>
      tracing.fetch((_url: string, i: typeof init) => {
        seen.push(i);
        return Promise.resolve(new Response());
      }, 'https://example.com/a', init),
    );
    expect(seen[0]).toBe(init);
  });
});

describe('the export', () => {
  it('sends all the spans of one request in one export call', async () => {
    const batches: number[] = [];
    const exporter: SpanExporter = {
      export: (spans, done) => {
        batches.push(spans.length);
        done({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.resolve(),
    };
    const { tracing } = setup(exporter);
    await tracing.serve({ name: 'x' }, async () => {
      await tracing.fetch(() => Promise.resolve(new Response()), 'https://a.example.com/', {});
      await tracing.fetch(() => Promise.resolve(new Response()), 'https://b.example.com/', {});
    });
    expect(batches).toEqual([3]);
  });

  it('does not fail the request when the export fails', async () => {
    const exporter: SpanExporter = {
      export: (_spans, done: (result: ExportResult) => void) => {
        done({ code: ExportResultCode.FAILED, error: new Error('endpoint down') });
      },
      shutdown: () => Promise.resolve(),
    };
    const { tracing } = setup(exporter);
    await expect(tracing.serve({ name: 'x' }, () => Promise.resolve('answer'))).resolves.toBe('answer');
  });

  it('does not wait for an export that never ends, longer than the flush limit', async () => {
    const exporter: SpanExporter = { export: () => undefined, shutdown: () => Promise.resolve() };
    const tracing = Tracing.create({ service: 's', version: '1', exporter, flushTimeoutMs: 50 });
    const started = Date.now();
    await expect(tracing.serve({ name: 'x' }, () => Promise.resolve('answer'))).resolves.toBe('answer');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('xrayTraceId', () => {
  it('writes the trace ID in the form of X-Ray: 1-, 8 hex digits, a dash and 24 hex digits', async () => {
    const { tracing } = setup();
    let id: string | undefined;
    await tracing.serve({ name: 'x', headers: { traceparent: TRACEPARENT } }, (span) => {
      id = xrayTraceId(span);
      return Promise.resolve();
    });
    expect(id).toBe('1-4bf92f35-77b34da6a3ce929d0e0e4736');
  });
});

describe('createDefaultTracing', () => {
  it('is disabled outside Lambda, which has no function name', () => {
    expect(createDefaultTracing('core', { AWS_REGION: 'eu-west-2' }).enabled).toBe(false);
  });

  it('is disabled when the setting TRACING is off', () => {
    expect(createDefaultTracing('core', { AWS_LAMBDA_FUNCTION_NAME: 'f', TRACING: 'off' }).enabled).toBe(false);
  });

  it('is enabled in Lambda', () => {
    expect(createDefaultTracing('core', { AWS_LAMBDA_FUNCTION_NAME: 'f', AWS_REGION: 'eu-west-2', VERSION: '1.0.0' }).enabled).toBe(true);
  });
});
