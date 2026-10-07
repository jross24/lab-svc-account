import { describe, expect, it, vi } from 'vitest';
import { CoreError, fetchCoreSummary } from '../lib/core-client.ts';
import type { CoreClientOptions } from '../lib/core-client.ts';

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
    { id: 'item-1', name: 'First item' },
    { id: 'item-2', name: 'Second item' },
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
