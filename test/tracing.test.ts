import { describe, expect, it, vi } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { Tracing, createDefaultTracing, parseSampleRatio, xrayTraceId } from '../lib/tracing.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE}-${PARENT}-01`;
const UNSAMPLED_TRACEPARENT = `00-${TRACE}-${PARENT}-00`;

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
    // Built at run time, so no password sits in the text of the file.
    const url = new URL('https://example.com/path?token=abc');
    url.username = 'name';
    url.password = 'secret';
    await tracing.serve({ name: 'x' }, () => tracing.fetch(recordingSend().send, url.href, {}));
    const client = byName(spans(), 'GET example.com');
    expect(JSON.stringify(client.attributes)).not.toMatch(/token|secret|abc/);
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

describe('the sampling ratio', () => {
  // An exporter that counts its calls and the spans in them.
  function counting() {
    const batches: number[] = [];
    const exporter: SpanExporter = {
      export: (spans, done) => {
        batches.push(spans.length);
        done({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.resolve(),
    };
    return { batches, exporter };
  }

  function withRatio(sampleRatio: number | undefined) {
    const { batches, exporter } = counting();
    const tracing = Tracing.create({ service: 'catalogue', version: '1.2.3', exporter, sampleRatio });
    return { tracing, batches };
  }

  const request = (tracing: Tracing, headers?: Record<string, string>) =>
    tracing.serve({ name: 'GET /products', headers }, () => Promise.resolve('answer'));

  // A call to the next service. It returns the traceparent that the call carries.
  async function callNext(tracing: Tracing): Promise<string | undefined> {
    let sent: string | undefined;
    await tracing.fetch(
      (_url, init: { headers?: Record<string, string> }) => {
        sent = init.headers?.traceparent;
        return Promise.resolve(new Response());
      },
      'https://a.example.com/',
      {},
    );
    return sent;
  }

  it('makes no export call for a request with ratio 0, and still answers', async () => {
    const { tracing, batches } = withRatio(0);
    await expect(request(tracing)).resolves.toBe('answer');
    expect(batches).toEqual([]);
  });

  it('makes one export call for a request with ratio 1', async () => {
    const { tracing, batches } = withRatio(1);
    await request(tracing);
    expect(batches).toEqual([1]);
  });

  it('samples every request when the ratio is not set', async () => {
    const { tracing, batches } = withRatio(undefined);
    await request(tracing);
    await request(tracing);
    expect(batches).toEqual([1, 1]);
  });

  it('follows a sampled parent in traceparent, also with ratio 0', async () => {
    const { tracing, batches } = withRatio(0);
    await request(tracing, { traceparent: TRACEPARENT });
    expect(batches).toEqual([1]);
  });

  it('never samples a request whose parent is not sampled, also with ratio 1', async () => {
    const { tracing, batches } = withRatio(1);
    for (let i = 0; i < 20; i++) await request(tracing, { traceparent: UNSAMPLED_TRACEPARENT });
    expect(batches).toEqual([]);
  });

  it('exports the spans of a failed request when it is sampled, and none when it is not', async () => {
    const sampled = withRatio(1);
    await expect(sampled.tracing.serve({ name: 'x' }, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(sampled.batches).toEqual([1]);
    const dropped = withRatio(0);
    await expect(dropped.tracing.serve({ name: 'x' }, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(dropped.batches).toEqual([]);
  });

  it('samples about the ratio of the requests that have no parent', async () => {
    const { tracing, batches } = withRatio(0.5);
    for (let i = 0; i < 400; i++) await request(tracing);
    // The trace ID decides, and the IDs are random. 400 requests give 200 plus or minus 10 (one standard deviation).
    // The limits are 6 standard deviations wide, so this test does not fail by chance.
    expect(batches.length).toBeGreaterThan(140);
    expect(batches.length).toBeLessThan(260);
  });

  it('keeps the trace ID of an unsampled request in the log field, and sends it on with the flag 00', async () => {
    const { tracing, batches } = withRatio(1);
    let id: string | undefined;
    let sent: string | undefined;
    await tracing.serve({ name: 'x', headers: { traceparent: UNSAMPLED_TRACEPARENT } }, async (span) => {
      id = xrayTraceId(span);
      sent = await callNext(tracing);
    });
    // The next service gets the flag 00 and does not sample either. The log lines of all services share the ID.
    expect(sent).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-00$`));
    expect(id).toBe('1-4bf92f35-77b34da6a3ce929d0e0e4736');
    expect(batches).toEqual([]);
  });

  it('sends the decision of a new trace on to the next service: flag 01 when sampled, 00 when not', async () => {
    const sampled = withRatio(1);
    await sampled.tracing.serve({ name: 'x' }, async () => {
      expect(await callNext(sampled.tracing)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });
    const dropped = withRatio(0);
    await dropped.tracing.serve({ name: 'x' }, async () => {
      expect(await callNext(dropped.tracing)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    });
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])('refuses the ratio %s, so a typo cannot switch tracing off', (ratio) => {
    expect(() => Tracing.create({ service: 's', version: '1', exporter: counting().exporter, sampleRatio: ratio })).toThrow(RangeError);
  });
});

describe('parseSampleRatio', () => {
  it.each([
    ['1', 1],
    ['0', 0],
    ['0.25', 0.25],
    [' 0.5 ', 0.5],
    ['1e-2', 0.01],
  ])('reads %j as %d', (text, expected) => {
    expect(parseSampleRatio(text)).toBe(expected);
  });

  it('passes a number in range on', () => {
    expect(parseSampleRatio(0.1)).toBe(0.1);
  });

  it.each(['', '  ', 'half', '1.5', '-0.1', 'NaN', 'Infinity', '10%'])('refuses %j', (text) => {
    expect(() => parseSampleRatio(text)).toThrow(/sampling ratio/);
  });
});

describe('createDefaultTracing and the setting TRACE_SAMPLE_RATIO', () => {
  const lambda = { AWS_LAMBDA_FUNCTION_NAME: 'f', AWS_REGION: 'eu-west-2', AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'secret' };

  // The exporter of the function reads process.env and sends with the global fetch. The test replaces both and
  // counts the calls to X-Ray.
  async function exportCalls(env: Record<string, string>): Promise<number> {
    const calls = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', calls);
    for (const [name, value] of Object.entries({ ...lambda, ...env })) vi.stubEnv(name, value);
    try {
      const tracing = createDefaultTracing('core');
      await tracing.serve({ name: 'x' }, () => Promise.resolve());
      return calls.mock.calls.length;
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }

  it('samples all requests when the setting is missing', async () => {
    expect(await exportCalls({})).toBe(1);
  });

  it('samples all requests when the setting is empty', async () => {
    expect(await exportCalls({ TRACE_SAMPLE_RATIO: '' })).toBe(1);
  });

  it('samples no request with TRACE_SAMPLE_RATIO=0: no call to X-Ray', async () => {
    expect(await exportCalls({ TRACE_SAMPLE_RATIO: '0' })).toBe(0);
  });

  it('samples every request with TRACE_SAMPLE_RATIO=1', async () => {
    expect(await exportCalls({ TRACE_SAMPLE_RATIO: '1' })).toBe(1);
  });

  it('falls back to all requests when the setting is not valid, because a lost trace costs more than a spare one', async () => {
    expect(await exportCalls({ TRACE_SAMPLE_RATIO: 'half' })).toBe(1);
  });
});
