import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { instrument, traceIdOf } from '../lib/instrument.ts';
import type { Signals } from '../lib/instrument.ts';

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
