import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { SpanKind } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { AccountStack } from '../lib/account-stack.ts';
import { CoreError, fetchCoreSummary } from '../lib/core-client.ts';
import { instrument } from '../lib/instrument.ts';
import { createHandler, handler } from '../lib/profile-handler.ts';
import { Tracing } from '../lib/tracing.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const coreAnswers = async () => ({ version: '0.3.0', itemCount: 3 });

describe('profile handler when core answers', () => {
  it('returns JSON with status 200', async () => {
    const response = await createHandler(coreAnswers)();
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('returns its own name and version, the version and item count of core, and the profile', async () => {
    vi.stubEnv('VERSION', '1.2.3');
    const body: unknown = JSON.parse((await createHandler(coreAnswers)()).body);
    expect(body).toEqual({
      service: 'account',
      version: '1.2.3',
      core: { version: '0.3.0', itemCount: 3 },
      profile: { id: 'user-1', name: 'First user', plan: 'free' },
    });
  });

  it('returns the version "unknown" when the environment has no version', async () => {
    vi.stubEnv('VERSION', undefined);
    const body: unknown = JSON.parse((await createHandler(coreAnswers)()).body);
    expect(body).toMatchObject({ version: 'unknown' });
  });
});

describe('profile handler when the core call fails', () => {
  it('returns status 502 with a JSON error that names the cause', async () => {
    vi.stubEnv('VERSION', '1.2.3');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await createHandler(async () => {
      throw new CoreError('core returned HTTP 403');
    })();
    expect(response.statusCode).toBe(502);
    expect(response.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(response.body)).toEqual({
      service: 'account',
      version: '1.2.3',
      error: 'The call to the core service failed.',
      cause: 'core returned HTTP 403',
    });
  });

  it('does not show the message of an unexpected error to the caller, and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unexpected = new Error('internal detail');
    const response = await createHandler(async () => {
      throw unexpected;
    })();
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body)).toMatchObject({ cause: 'unexpected error' });
    expect(response.body).not.toContain('internal detail');
    expect(log).toHaveBeenCalledWith('The call to the core service failed.', unexpected);
  });
});

describe('profile handler fault switch', () => {
  it('throws on each call when INJECT_FAULT is true, and does not call core', async () => {
    vi.stubEnv('INJECT_FAULT', 'true');
    const getCore = vi.fn(coreAnswers);
    const call = createHandler(getCore);
    await expect(call()).rejects.toThrow(/injected fault/);
    await expect(call()).rejects.toThrow(/injected fault/);
    expect(getCore).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'false', 'TRUE', '1'])('does not throw when INJECT_FAULT is %j', async (value) => {
    vi.stubEnv('INJECT_FAULT', value);
    await expect(createHandler(coreAnswers)()).resolves.toMatchObject({ statusCode: 200 });
  });
});

// The tests below use the exported handler. It is the function that Lambda runs: the instrument wrapper,
// the real handler and the real core client. Only the network is fake: the global fetch plays the core API.
const EVENT = { routeKey: 'GET /profile' } as APIGatewayProxyEventV2;
const CONTEXT = { awsRequestId: 'req-42' } as Context;

interface LogLine {
  readonly level?: string;
  readonly status?: number;
  readonly error?: string;
  readonly [key: string]: unknown;
}

interface MetricLine {
  readonly _aws: {
    readonly CloudWatchMetrics: readonly {
      readonly Namespace: string;
      readonly Dimensions: readonly (readonly string[])[];
      readonly Metrics: readonly { readonly Name: string }[];
    }[];
  };
  readonly [key: string]: unknown;
}

function fakeCore(core: Response | Error) {
  // Fake values. The credentials are the example values from the AWS documentation and open nothing.
  vi.stubEnv('VERSION', '1.2.3');
  vi.stubEnv('CORE_URL', 'https://abc123.execute-api.eu-west-2.amazonaws.com');
  vi.stubEnv('AWS_REGION', 'eu-west-2');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  vi.stubEnv('AWS_SESSION_TOKEN', 'fake-session-token');
  const fetch = vi.fn(async () => {
    if (core instanceof Error) throw core;
    return core;
  });
  vi.stubGlobal('fetch', fetch);
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // The wrapper writes straight to stdout. This spy keeps the two lines of the request.
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  const lines = (): { log: LogLine; metric: MetricLine } => {
    const json = written.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as unknown);
    expect(json).toHaveLength(2);
    return { log: json[0] as LogLine, metric: json[1] as MetricLine };
  };
  return { fetch, log, lines };
}

describe('the exported handler when the core call fails', () => {
  it.each([
    ['core answers HTTP 503', () => Response.json({ message: 'Service Unavailable' }, { status: 503 })],
    ['core answers HTTP 403', () => Response.json({ Message: 'Forbidden' }, { status: 403 })],
    ['the request to core fails', () => new TypeError('fetch failed')],
    ['core answers a body that the service does not understand', () => new Response('not json')],
  ])('counts the call as an error in the metric line and logs it at level ERROR when %s', async (_name, core) => {
    const fake = fakeCore(core());
    // The handler returns 502 and does not throw. Lambda sees a call with no error. So the Errors metric of Lambda
    // stays at 0, and only the metric line of the wrapper shows the failure. The third alarm reads that line.
    const response = await handler(EVENT, CONTEXT);
    expect(response.statusCode).toBe(502);
    expect(fake.fetch).toHaveBeenCalledTimes(1);

    const { log, metric } = fake.lines();
    expect(log).toMatchObject({
      level: 'ERROR',
      service: 'account',
      version: '1.2.3',
      requestId: 'req-42',
      route: 'GET /profile',
      status: 502,
    });
    expect(log).not.toHaveProperty('error');
    expect(metric).toMatchObject({ service: 'account', version: '1.2.3', requests: 1, errors: 1 });
  });

  it('keeps the text line with the full error for the log of the function', async () => {
    const failure = new TypeError('fetch failed');
    const fake = fakeCore(failure);
    await handler(EVENT, CONTEXT);
    expect(fake.log).toHaveBeenCalledWith(
      'The call to the core service failed.',
      expect.objectContaining({ cause: failure }),
    );
  });

  it('counts no error when core answers', async () => {
    const fake = fakeCore(Response.json({ service: 'core', version: '0.3.0', items: [{ id: 'item-1' }] }));
    const response = await handler(EVENT, CONTEXT);
    expect(response.statusCode).toBe(200);
    const { log, metric } = fake.lines();
    expect(log).toMatchObject({ level: 'INFO', status: 200 });
    expect(metric).toMatchObject({ requests: 1, errors: 0 });
  });
});

describe('the handler with tracing', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const PARENT = '00f067aa0ba902b7';

  it('uses one trace ID in the log line, in the spans, and in the header traceparent that goes to core', async () => {
    const memory = new InMemorySpanExporter();
    const tracing = Tracing.create({ service: 'account', version: '1.2.3', exporter: memory });
    const sent: Record<string, string>[] = [];
    const written: string[] = [];
    // The real wrapper, the real handler and the real core client. Only the network and the output are fake.
    const traced = instrument(
      { service: 'account', tracing, write: (line) => written.push(line) },
      createHandler(() =>
        fetchCoreSummary({
          tracing,
          env: {
            CORE_URL: 'https://abc123.execute-api.eu-west-2.amazonaws.com',
            AWS_REGION: 'eu-west-2',
            // Fake values. The credentials are the example values from the AWS documentation and open nothing.
            AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
            AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          },
          fetch: async (_url, init) => {
            sent.push(init.headers);
            return Response.json({ service: 'core', version: '0.3.0', items: [{ id: 'item-1' }] });
          },
        }),
      ),
    );
    const event = { ...EVENT, headers: { traceparent: `00-${TRACE}-${PARENT}-01` } } as APIGatewayProxyEventV2;

    const response = await traced(event, CONTEXT);

    expect(response.statusCode).toBe(200);
    const spans = memory.getFinishedSpans();
    expect(spans.map((span) => span.kind).sort()).toEqual([SpanKind.SERVER, SpanKind.CLIENT].sort());
    expect(spans.every((span) => span.spanContext().traceId === TRACE)).toBe(true);
    expect((JSON.parse(written[0] ?? 'null') as LogLine).traceId).toBe('1-4bf92f35-77b34da6a3ce929d0e0e4736');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.traceparent).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));
  });
});

describe('the exported handler with the fault switch on', () => {
  it('throws to Lambda, logs level ERROR with status 500, counts an error, and does not call core', async () => {
    const fake = fakeCore(Response.json({ service: 'core', version: '0.3.0', items: [] }));
    vi.stubEnv('INJECT_FAULT', 'true');
    // The error must reach Lambda. Then the Errors metric of Lambda counts it as well.
    await expect(handler(EVENT, CONTEXT)).rejects.toThrow(/injected fault/);
    expect(fake.fetch).not.toHaveBeenCalled();
    const { log, metric } = fake.lines();
    expect(log).toMatchObject({ level: 'ERROR', status: 500 });
    expect(log.error).toContain('injected fault');
    expect(metric).toMatchObject({ requests: 1, errors: 1 });
  });
});

describe('the metric that the third alarm watches', () => {
  // The synth bundles the function with esbuild. It takes a few seconds, so it runs here and not in the test.
  const template = Template.fromStack(
    new AccountStack(new App(), 'Account', {
      version: '1.2.3',
      config: { logRetentionDays: RetentionDays.ONE_WEEK, release: { kind: 'allAtOnce' }, injectFault: false, traceSampleRatio: 1 },
    }),
  );

  it('is the metric that the exported handler writes: the same namespace, name, service and version', async () => {
    const fake = fakeCore(new TypeError('fetch failed'));
    await handler(EVENT, CONTEXT);
    const { metric } = fake.lines();
    const definition = metric._aws.CloudWatchMetrics[0];

    const [alarm] = Object.values(
      template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'errors' } }),
    ) as { Properties: { Namespace: string; MetricName: string; Dimensions: { Name: string; Value: string }[] } }[];

    expect(alarm?.Properties.Namespace).toBe(definition?.Namespace);
    expect(definition?.Metrics.map((entry) => entry.Name)).toContain(alarm?.Properties.MetricName);
    const written = (definition?.Dimensions[0] ?? []).map((name) => ({ Name: name, Value: metric[name] }));
    const byName = (a: { Name: string }, b: { Name: string }): number => a.Name.localeCompare(b.Name);
    expect([...(alarm?.Properties.Dimensions ?? [])].sort(byName)).toEqual(written.sort(byName));
  });
});
