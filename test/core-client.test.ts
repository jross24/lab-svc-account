import { describe, expect, it, vi } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { CoreError, fetchCoreSummary } from '../lib/core-client.ts';
import type { CoreClientOptions } from '../lib/core-client.ts';
import { signGet } from '../lib/sign.ts';
import { Tracing } from '../lib/tracing.ts';

// Fake values. The credentials are the example values from the AWS documentation and open nothing.
const ENV = {
  CORE_URL: 'https://abc123.execute-api.eu-west-2.amazonaws.com',
  AWS_REGION: 'eu-west-2',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_SESSION_TOKEN: 'fake-session-token',
};

const CORE_BODY = {
  service: 'core',
  version: '0.3.0',
  items: [
    { id: 'item-1', title: 'First item' },
    { id: 'item-2', title: 'Second item' },
  ],
};

function options(response: Response | Error, env: Record<string, string | undefined> = ENV) {
  const fetch = vi.fn<NonNullable<CoreClientOptions['fetch']>>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { fetch, env };
}

function failure(opts: CoreClientOptions): Promise<unknown> {
  return fetchCoreSummary(opts).then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

describe('fetchCoreSummary', () => {
  it('returns the version of core and the number of items', async () => {
    const summary = await fetchCoreSummary(options(Response.json(CORE_BODY)));
    expect(summary).toEqual({ version: '0.3.0', itemCount: 2 });
  });

  it('sends one signed GET request to /items of the core URL', async () => {
    const opts = options(Response.json(CORE_BODY));
    await fetchCoreSummary(opts);
    expect(opts.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = opts.fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://abc123.execute-api.eu-west-2.amazonaws.com/items');
    expect(init?.method).toBe('GET');
    expect(init?.headers.authorization).toMatch(/\/eu-west-2\/execute-api\/aws4_request/);
    expect(init?.headers['x-amz-security-token']).toBe('fake-session-token');
  });

  it('throws a CoreError with the status when core does not return 200', async () => {
    const forbidden = new Response('{"Message":"a detail that the caller must not see"}', { status: 403 });
    const error = await failure(options(forbidden));
    expect(error).toBeInstanceOf(CoreError);
    expect(error).toHaveProperty('message', 'core returned HTTP 403');
  });

  it('throws a CoreError when the request fails', async () => {
    const error = await failure(options(new TypeError('fetch failed')));
    expect(error).toBeInstanceOf(CoreError);
    expect(error).toHaveProperty('message', 'the request to core failed');
  });

  it.each(['not json', '{"service":"core"}', '{"version":1,"items":[]}', '{"version":"1.0.0","items":{}}'])(
    'throws a CoreError when the body is %j',
    async (body) => {
      const error = await failure(options(new Response(body)));
      expect(error).toBeInstanceOf(CoreError);
      expect(error).toHaveProperty('message', 'core returned a body that this service does not understand');
    },
  );

  it.each(['CORE_URL', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'])(
    'throws a CoreError and sends no request when the environment has no %s',
    async (name) => {
      const opts = options(Response.json(CORE_BODY), { ...ENV, [name]: undefined });
      const error = await failure(opts);
      expect(error).toBeInstanceOf(CoreError);
      expect(error).toHaveProperty('message', `the environment variable ${name} is not set`);
      expect(opts.fetch).not.toHaveBeenCalled();
    },
  );
});

describe('fetchCoreSummary with tracing', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const PARENT = '00f067aa0ba902b7';
  const CORE_HOST = 'abc123.execute-api.eu-west-2.amazonaws.com';

  function traced(response: Response | Error = Response.json(CORE_BODY)) {
    const memory = new InMemorySpanExporter();
    const tracing = Tracing.create({ service: 'account', version: '1.2.3', exporter: memory });
    return { memory, tracing, ...options(response) };
  }

  // The call under test: the fake fetch, the fake environment and the tracing of the test.
  function call(opts: ReturnType<typeof traced>): Promise<unknown> {
    return fetchCoreSummary({ fetch: opts.fetch, env: opts.env, tracing: opts.tracing });
  }

  // The headers that the signer gives for the same request at the same second. The date of the request names the second.
  async function signedAgain(sent: Record<string, string>): Promise<Record<string, string>> {
    const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(sent['x-amz-date'] ?? '');
    expect(date).not.toBeNull();
    const [, year, month, day, hour, minute, second] = date as RegExpExecArray;
    return signGet({
      url: `${ENV.CORE_URL}/items`,
      region: ENV.AWS_REGION,
      credentials: {
        accessKeyId: ENV.AWS_ACCESS_KEY_ID,
        secretAccessKey: ENV.AWS_SECRET_ACCESS_KEY,
        sessionToken: ENV.AWS_SESSION_TOKEN,
      },
      now: new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`),
    });
  }

  function sentHeaders(opts: ReturnType<typeof traced>): Record<string, string> {
    expect(opts.fetch).toHaveBeenCalledTimes(1);
    return opts.fetch.mock.calls[0]?.[1].headers ?? {};
  }

  it('sends the signed headers unchanged and adds the header traceparent', async () => {
    const opts = traced();
    await opts.tracing.serve({ name: 'GET /profile', headers: { traceparent: `00-${TRACE}-${PARENT}-01` } }, () =>
      call(opts),
    );
    const sent = sentHeaders(opts);
    const { traceparent, ...signed } = sent;
    expect(traceparent).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));
    expect(signed).toEqual(await signedAgain(sent));
  });

  it('does not list traceparent or x-amzn-trace-id in the SignedHeaders of the signature', async () => {
    const opts = traced();
    await opts.tracing.serve({ name: 'GET /profile' }, () => call(opts));
    const sent = sentHeaders(opts);
    const listed = /SignedHeaders=([^,]+),/.exec(sent.authorization ?? '')?.[1]?.split(';') ?? [];
    expect(listed.length).toBeGreaterThan(0);
    // The signature covers the host and the x-amz headers only. So a header that the caller adds later does not break it.
    for (const name of listed) expect(name === 'host' || name.startsWith('x-amz-'), name).toBe(true);
    expect(listed).not.toContain('traceparent');
    expect(listed).not.toContain('x-amzn-trace-id');
    expect(sent).not.toHaveProperty('x-amzn-trace-id');
  });

  it('records one client span as a child of the server span, and the header carries the id of that client span', async () => {
    const opts = traced();
    await opts.tracing.serve({ name: 'GET /profile', headers: { traceparent: `00-${TRACE}-${PARENT}-01` } }, () =>
      call(opts),
    );
    const spans = opts.memory.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const server = spans.find((span) => span.kind === SpanKind.SERVER);
    const client = spans.find((span) => span.kind === SpanKind.CLIENT);
    expect(client?.name).toBe(`GET ${CORE_HOST}`);
    expect(client?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId);
    expect(client?.spanContext().traceId).toBe(TRACE);
    expect(client?.attributes['http.response.status_code']).toBe(200);
    expect(sentHeaders(opts).traceparent).toBe(`00-${TRACE}-${client?.spanContext().spanId}-01`);
  });

  it('sends the headers unchanged outside of a server span, and records no span', async () => {
    const opts = traced();
    await call(opts);
    const sent = sentHeaders(opts);
    expect(sent).not.toHaveProperty('traceparent');
    expect(sent).toEqual(await signedAgain(sent));
    expect(opts.memory.getFinishedSpans()).toHaveLength(0);
  });

  it('sends the headers unchanged when the tracing is off, which is the default outside of Lambda', async () => {
    const opts = options(Response.json(CORE_BODY));
    await fetchCoreSummary(opts);
    expect(opts.fetch.mock.calls[0]?.[1].headers).not.toHaveProperty('traceparent');
  });

  it('marks the client span as an error when core answers 403, and still throws the same safe CoreError', async () => {
    const forbidden = new Response('{"Message":"a detail that the caller must not see"}', { status: 403 });
    const opts = traced(forbidden);
    const caught = await opts.tracing
      .serve({ name: 'GET /profile' }, () => call(opts))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(caught).toBeInstanceOf(CoreError);
    expect(caught).toHaveProperty('message', 'core returned HTTP 403');
    const client = opts.memory.getFinishedSpans().find((span) => span.kind === SpanKind.CLIENT);
    expect(client?.status.code).toBe(SpanStatusCode.ERROR);
    expect(client?.attributes['http.response.status_code']).toBe(403);
    // The span must not carry the body of the answer.
    const recorded = JSON.stringify({ attributes: client?.attributes, status: client?.status, events: client?.events });
    expect(recorded).not.toContain('a detail that the caller must not see');
  });

  it('marks the client span as an error when the request fails, and still throws the same safe CoreError', async () => {
    const opts = traced(new TypeError('fetch failed'));
    const caught = await opts.tracing
      .serve({ name: 'GET /profile' }, () => call(opts))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(caught).toBeInstanceOf(CoreError);
    expect(caught).toHaveProperty('message', 'the request to core failed');
    const client = opts.memory.getFinishedSpans().find((span) => span.kind === SpanKind.CLIENT);
    expect(client?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
