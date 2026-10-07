import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { instrument, traceIdOf } from '../lib/instrument.ts';
import type { Signals } from '../lib/instrument.ts';
import { Tracing } from '../lib/tracing.ts';

const EVENT = { routeKey: 'GET /profile' } as APIGatewayProxyEventV2;
const CONTEXT = { awsRequestId: 'req-42' } as Context;

function setup(env: Record<string, string | undefined> = {}) {
  const lines: string[] = [];
  // The fake clock moves 7 ms on each read, so a request that reads it twice takes 7 ms.
  let clock = 1000;
  const wrap = <T extends { statusCode: number }>(
    handler: (event: APIGatewayProxyEventV2, context: Context, signals: Signals) => Promise<T>,
  ) =>
    instrument(
      {
        service: 'account',
        env: () => ({ VERSION: '1.2.3', ...env }),
        write: (line) => lines.push(line),
        clock: () => (clock += 7),
        now: () => new Date('2026-10-07T20:15:30.123Z'),
      },
      handler,
    );
  return { lines, wrap };
}

function parse(line: string | undefined): unknown {
  return JSON.parse(line ?? 'null');
}

describe('instrument', () => {
  it('returns the response of the handler unchanged', async () => {
    const { wrap } = setup();
    const response = { statusCode: 200, body: 'ok' };
    await expect(wrap(() => Promise.resolve(response))(EVENT, CONTEXT)).resolves.toBe(response);
  });

  it('writes one log line and then one metric line for a request', async () => {
    const { lines, wrap } = setup();
    await wrap(() => Promise.resolve({ statusCode: 200 }))(EVENT, CONTEXT);
    expect(lines).toHaveLength(2);
    expect(parse(lines[0])).toEqual({
      timestamp: '2026-10-07T20:15:30.123Z',
      level: 'INFO',
      service: 'account',
      version: '1.2.3',
      requestId: 'req-42',
      route: 'GET /profile',
      status: 200,
      durationMs: 7,
      coldStart: true,
    });
    expect(parse(lines[1])).toMatchObject({
      service: 'account',
      version: '1.2.3',
      requests: 1,
      errors: 0,
      duration: 7,
    });
  });

  it('counts a response with a 5xx status as an error', async () => {
    const { lines, wrap } = setup();
    await wrap(() => Promise.resolve({ statusCode: 503 }))(EVENT, CONTEXT);
    expect(parse(lines[0])).toMatchObject({ level: 'ERROR', status: 503 });
    expect(parse(lines[1])).toMatchObject({ errors: 1 });
  });

  it('does not count a 4xx status as an error', async () => {
    const { lines, wrap } = setup();
    await wrap(() => Promise.resolve({ statusCode: 404 }))(EVENT, CONTEXT);
    expect(parse(lines[0])).toMatchObject({ level: 'WARN', status: 404 });
    expect(parse(lines[1])).toMatchObject({ errors: 0 });
  });

  it('logs a thrown error with status 500, counts it, and throws the same error again', async () => {
    const { lines, wrap } = setup();
    const failure = new Error('boom');
    // The error must reach Lambda. Only then does the Errors metric of Lambda count the call.
    await expect(wrap(() => Promise.reject(failure))(EVENT, CONTEXT)).rejects.toBe(failure);
    expect(parse(lines[0])).toMatchObject({ level: 'ERROR', status: 500, error: 'boom' });
    expect(parse(lines[1])).toMatchObject({ requests: 1, errors: 1 });
  });

  it('uses the version "unknown" when the environment has no version', async () => {
    const { lines, wrap } = setup({ VERSION: undefined });
    await wrap(() => Promise.resolve({ statusCode: 200 }))(EVENT, CONTEXT);
    expect(parse(lines[0])).toMatchObject({ version: 'unknown' });
    expect(parse(lines[1])).toMatchObject({ version: 'unknown' });
  });

  it('adds the trace ID from the environment of Lambda to the log line', async () => {
    const { lines, wrap } = setup({
      _X_AMZN_TRACE_ID: 'Root=1-6700aaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=53995c3f42cd8ad8;Sampled=1',
    });
    await wrap(() => Promise.resolve({ statusCode: 200 }))(EVENT, CONTEXT);
    expect(parse(lines[0])).toMatchObject({ traceId: '1-6700aaaa-bbbbbbbbbbbbbbbbbbbbbbbb' });
  });

  it('marks only the first request of a handler as a cold start', async () => {
    const { lines, wrap } = setup();
    const handler = wrap(() => Promise.resolve({ statusCode: 200 }));
    await handler(EVENT, CONTEXT);
    await handler(EVENT, CONTEXT);
    expect(parse(lines[0])).toMatchObject({ coldStart: true });
    expect(parse(lines[2])).not.toHaveProperty('coldStart');
  });

  it('counts a new handler as a new cold start, because a new handler is a new execution environment', async () => {
    const { lines, wrap } = setup();
    await wrap(() => Promise.resolve({ statusCode: 200 }))(EVENT, CONTEXT);
    await wrap(() => Promise.resolve({ statusCode: 200 }))(EVENT, CONTEXT);
    expect(parse(lines[0])).toMatchObject({ coldStart: true });
    expect(parse(lines[2])).toMatchObject({ coldStart: true });
  });

  it('writes no coldStart field to the metric line', async () => {
    const { lines, wrap } = setup();
    await wrap(() => Promise.resolve({ statusCode: 200 }))(EVENT, CONTEXT);
    expect(parse(lines[1])).not.toHaveProperty('coldStart');
  });

  it('counts a call as an error when the handler reports a degraded answer, also with the status 200', async () => {
    // A page can render with a failed upstream. The user sees an error block, but the status is 200 and Lambda sees no error.
    const { lines, wrap } = setup();
    await wrap((_event, _context, signals) => {
      signals.degraded = 'catalogue: HTTP 503';
      return Promise.resolve({ statusCode: 200 });
    })(EVENT, CONTEXT);
    expect(parse(lines[0])).toMatchObject({ level: 'WARN', status: 200, degraded: 'catalogue: HTTP 503' });
    expect(parse(lines[1])).toMatchObject({ requests: 1, errors: 1 });
  });

  it('gives each call a fresh signals object, so one degraded call does not mark the next call', async () => {
    const { lines, wrap } = setup();
    let first = true;
    const handler = wrap((_event, _context, signals) => {
      if (first) signals.degraded = 'account: the request timed out';
      first = false;
      return Promise.resolve({ statusCode: 200 });
    });
    await handler(EVENT, CONTEXT);
    await handler(EVENT, CONTEXT);
    expect(parse(lines[1])).toMatchObject({ errors: 1 });
    expect(parse(lines[3])).toMatchObject({ errors: 0 });
    expect(parse(lines[2])).not.toHaveProperty('degraded');
  });

  it('logs the route key of the event', async () => {
    const { lines, wrap } = setup();
    await wrap(() => Promise.resolve({ statusCode: 200 }))({ routeKey: '$default' } as APIGatewayProxyEventV2, CONTEXT);
    expect(parse(lines[0])).toMatchObject({ route: '$default' });
  });
});

describe('traceIdOf', () => {
  it('reads the Root part of the trace header', () => {
    expect(traceIdOf({ _X_AMZN_TRACE_ID: 'Root=1-abc-def;Parent=1234;Sampled=1' })).toBe('1-abc-def');
  });

  it('returns nothing when the header is missing or has no Root', () => {
    expect(traceIdOf({})).toBeUndefined();
    expect(traceIdOf({ _X_AMZN_TRACE_ID: 'Sampled=1' })).toBeUndefined();
  });
});

describe('instrument with tracing', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const PARENT = '00f067aa0ba902b7';

  function traced(env: Record<string, string | undefined> = {}) {
    const lines: string[] = [];
    const memory = new InMemorySpanExporter();
    const tracing = Tracing.create({ service: 'account', version: '1.2.3', exporter: memory });
    const wrap = <T extends { statusCode: number }>(
      handler: (event: APIGatewayProxyEventV2, context: Context, signals: Signals) => Promise<T>,
    ) =>
      instrument(
        {
          service: 'account',
          tracing,
          env: () => ({ VERSION: '1.2.3', ...env }),
          write: (line) => lines.push(line),
          now: () => new Date('2026-10-07T20:15:30.123Z'),
        },
        handler,
      );
    return { lines, memory, tracing, wrap };
  }

  const event = (headers?: Record<string, string>): APIGatewayProxyEventV2 =>
    ({ routeKey: 'GET /profile', rawPath: '/profile', headers, requestContext: { http: { method: 'GET' } } }) as unknown as APIGatewayProxyEventV2;

  it('records one server span for a request, named after the route, with the attributes of the request', async () => {
    const { memory, wrap } = traced();
    await wrap(() => Promise.resolve({ statusCode: 200 }))(event(), CONTEXT);
    const [span] = memory.getFinishedSpans();
    expect(memory.getFinishedSpans()).toHaveLength(1);
    expect(span).toMatchObject({ name: 'GET /profile', kind: SpanKind.SERVER });
    expect(span?.attributes).toMatchObject({
      'http.request.method': 'GET',
      'url.path': '/profile',
      'http.response.status_code': 200,
      'faas.invocation_id': 'req-42',
      'faas.coldstart': true,
    });
  });

  it('puts the trace ID of the span into the log line, in the form of X-Ray', async () => {
    const { lines, memory, wrap } = traced({ _X_AMZN_TRACE_ID: 'Root=1-6700aaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=53995c3f42cd8ad8;Sampled=0' });
    await wrap(() => Promise.resolve({ statusCode: 200 }))(event(), CONTEXT);
    const id = memory.getFinishedSpans()[0]?.spanContext().traceId ?? '';
    expect(parse(lines[0])).toMatchObject({ traceId: `1-${id.slice(0, 8)}-${id.slice(8)}` });
  });

  it('continues the trace of the caller: the log line and the span carry the trace ID of the traceparent header', async () => {
    const { lines, memory, wrap } = traced();
    await wrap(() => Promise.resolve({ statusCode: 200 }))(event({ traceparent: `00-${TRACE}-${PARENT}-01` }), CONTEXT);
    expect(parse(lines[0])).toMatchObject({ traceId: '1-4bf92f35-77b34da6a3ce929d0e0e4736' });
    expect(memory.getFinishedSpans()[0]?.parentSpanContext?.spanId).toBe(PARENT);
  });

  it('marks the span as an error for a status of 500 or more, and for a degraded answer', async () => {
    const { memory, wrap } = traced();
    await wrap(() => Promise.resolve({ statusCode: 502 }))(event(), CONTEXT);
    await wrap((_event, _context, signals) => {
      signals.degraded = 'account: HTTP 503';
      return Promise.resolve({ statusCode: 200 });
    })(event(), CONTEXT);
    await wrap(() => Promise.resolve({ statusCode: 200 }))(event(), CONTEXT);
    expect(memory.getFinishedSpans().map((span) => span.status.code)).toEqual([
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
      SpanStatusCode.UNSET,
    ]);
  });

  it('records a thrown error on the span and throws it again', async () => {
    const { memory, wrap } = traced();
    const failure = new Error('boom');
    await expect(wrap(() => Promise.reject(failure))(event(), CONTEXT)).rejects.toBe(failure);
    expect(memory.getFinishedSpans()[0]?.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'boom' });
  });

  it('lets the handler call another service as a child span of the request', async () => {
    const { memory, tracing, wrap } = traced();
    await wrap(async () => {
      await tracing.fetch(() => Promise.resolve(new Response('{}')), 'https://core.example.com/items', {});
      return { statusCode: 200 };
    })(event(), CONTEXT);
    const server = memory.getFinishedSpans().find((span) => span.kind === SpanKind.SERVER);
    const client = memory.getFinishedSpans().find((span) => span.kind === SpanKind.CLIENT);
    expect(client?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId);
  });

  it('writes the log line before the export, so a slow export does not hide the line', async () => {
    const order: string[] = [];
    const exporter = {
      export: (_spans: unknown, done: (result: { code: number }) => void) => {
        order.push('export');
        done({ code: 0 });
      },
      shutdown: () => Promise.resolve(),
    };
    const tracing = Tracing.create({ service: 'account', version: '1', exporter });
    const handler = instrument(
      { service: 'account', tracing, env: () => ({}), write: (line) => order.push(line.startsWith('{"timestamp"') ? 'log' : 'metric') },
      () => Promise.resolve({ statusCode: 200 }),
    );
    await handler(event(), CONTEXT);
    expect(order).toEqual(['log', 'metric', 'export']);
  });
});
