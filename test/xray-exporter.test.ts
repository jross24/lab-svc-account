import { describe, expect, it } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { XRayExporter } from '../lib/xray-exporter.ts';

const ENV = {
  AWS_REGION: 'eu-west-2',
  AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secret',
  AWS_SESSION_TOKEN: 'token',
};

function oneSpan(): ReadableSpan {
  const memory = new InMemorySpanExporter();
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'core' }),
    spanProcessors: [new SimpleSpanProcessor({ exporter: memory })],
  });
  provider.getTracer('test').startSpan('GET /items').end();
  return memory.getFinishedSpans()[0] as ReadableSpan;
}

interface Call {
  readonly url: string;
  readonly init: { method: string; headers: Record<string, string>; body: string };
}

function setup(respond: () => Promise<Response> = () => Promise.resolve(new Response('{}', { status: 200 }))) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const exporter = new XRayExporter({
    env: () => ENV,
    fetch: (url, init) => {
      calls.push({ url: String(url), init: init as Call['init'] });
      return respond();
    },
    log: (line) => logs.push(line),
  });
  const send = (spans: ReadableSpan[]): Promise<ExportResult> =>
    new Promise((resolve) => {
      exporter.export(spans, resolve);
    });
  return { calls, logs, send };
}

describe('XRayExporter', () => {
  it('posts the spans as OTLP JSON to the X-Ray endpoint of the region', async () => {
    const { calls, send } = setup();
    expect((await send([oneSpan()])).code).toBe(ExportResultCode.SUCCESS);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://xray.eu-west-2.amazonaws.com/v1/traces');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers['content-type']).toBe('application/json');
    const body = JSON.parse(calls[0]?.init.body ?? '') as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] };
    expect(body.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.name).toBe('GET /items');
  });

  it('writes the trace ID and the span ID as hex text, which is the OTLP JSON form', async () => {
    const { calls, send } = setup();
    const span = oneSpan();
    await send([span]);
    const body = JSON.parse(calls[0]?.init.body ?? '') as { resourceSpans: { scopeSpans: { spans: { traceId: string; spanId: string }[] }[] }[] };
    expect(body.resourceSpans[0]?.scopeSpans[0]?.spans[0]).toMatchObject({
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
    });
  });

  it('signs the request for the service xray with the credentials of the environment', async () => {
    const { calls, send } = setup();
    await send([oneSpan()]);
    const headers = calls[0]?.init.headers ?? {};
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/[0-9]{8}\/eu-west-2\/xray\/aws4_request, /);
    expect(headers['x-amz-security-token']).toBe('token');
    expect(headers.authorization).toContain('SignedHeaders=content-type;host;x-amz-date;x-amz-security-token');
  });

  it('reports a failed answer, logs the status and the error type, and does not log the body', async () => {
    const { logs, send } = setup(() =>
      Promise.resolve(
        new Response('User: arn:aws:sts::SECRET-ACCOUNT-ID:assumed-role/x is not authorized', {
          status: 403,
          headers: { 'x-amzn-errortype': 'AccessDeniedException' },
        }),
      ),
    );
    expect((await send([oneSpan()])).code).toBe(ExportResultCode.FAILED);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? '')).toMatchObject({
      level: 'WARN',
      message: 'trace export failed',
      status: 403,
      errorType: 'AccessDeniedException',
    });
    expect(logs[0]).not.toContain('SECRET-ACCOUNT-ID');
  });

  it('reports a network error as a failure and does not throw', async () => {
    const { logs, send } = setup(() => Promise.reject(new Error('socket hang up')));
    expect((await send([oneSpan()])).code).toBe(ExportResultCode.FAILED);
    expect(JSON.parse(logs[0] ?? '')).toMatchObject({ level: 'WARN', message: 'trace export failed', error: 'socket hang up' });
  });

  it('reports a failure when the environment has no credentials', async () => {
    const calls: unknown[] = [];
    const logs: string[] = [];
    const exporter = new XRayExporter({
      env: () => ({ AWS_REGION: 'eu-west-2' }),
      fetch: (url) => {
        calls.push(url);
        return Promise.resolve(new Response('{}'));
      },
      log: (line) => logs.push(line),
    });
    const result = await new Promise<ExportResult>((resolve) => {
      exporter.export([oneSpan()], resolve);
    });
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(calls).toHaveLength(0);
    expect(logs[0]).toContain('no credentials');
  });

  it('sends nothing for an empty batch', async () => {
    const { calls, send } = setup();
    expect((await send([])).code).toBe(ExportResultCode.SUCCESS);
    expect(calls).toHaveLength(0);
  });

  it('shuts down without work', async () => {
    await expect(new XRayExporter({ env: () => ENV }).shutdown()).resolves.toBeUndefined();
  });
});
