import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { signRequest } from './sigv4.ts';

type Env = Record<string, string | undefined>;

export interface XRayExporterOptions {
  // The tests replace these three fields. In Lambda the defaults are right.
  readonly env?: () => Env;
  readonly fetch?: typeof fetch;
  readonly log?: (line: string) => void;
  // The longest time for one export. A slow endpoint must not hold the answer of the function for long.
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

function writeToStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

// Sends spans to the OTLP endpoint of X-Ray: https://xray.<region>.amazonaws.com/v1/traces
// The endpoint wants a request that is signed with AWS Signature Version 4 for the service "xray".
// The OpenTelemetry exporter for JavaScript cannot sign a request, so this class does it.
// The endpoint works only when CloudWatch Transaction Search is on in the account.
// The stack Platform of lab-platform owns that setting (see the README section "Why Transaction Search, and who owns it" of lab-svc-core).
// A failed export never fails a request of the function: the class logs one line and reports the failure.
export class XRayExporter implements SpanExporter {
  readonly #env: () => Env;
  readonly #fetch: typeof fetch;
  readonly #log: (line: string) => void;
  readonly #timeoutMs: number;

  constructor(options: XRayExporterOptions = {}) {
    this.#env = options.env ?? ((): Env => process.env);
    this.#fetch = options.fetch ?? fetch;
    this.#log = options.log ?? writeToStdout;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.#send(spans).then(
      () => {
        resultCallback({ code: ExportResultCode.SUCCESS });
      },
      (error: unknown) => {
        resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  async #send(spans: ReadableSpan[]): Promise<void> {
    if (spans.length === 0) return;
    const env = this.#env();
    const accessKeyId = env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
    const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    if (!accessKeyId || !secretAccessKey || !region) {
      this.#warn({ error: 'no credentials or no region in the environment' });
      throw new Error('no credentials');
    }

    const body = new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans));
    const url = `https://xray.${region}.amazonaws.com/v1/traces`;
    const headers = signRequest({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      body,
      region,
      service: 'xray',
      credentials: { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN },
    });

    let response: Response;
    try {
      response = await this.#fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (cause) {
      this.#warn({ error: cause instanceof Error ? cause.message : 'unknown error' });
      throw cause;
    }
    // The body of an error answer can name the role and the account, so the log gets the status and the type only.
    if (!response.ok) {
      this.#warn({ status: response.status, errorType: response.headers.get('x-amzn-errortype') ?? undefined });
      throw new Error(`the endpoint answered HTTP ${response.status}`);
    }
  }

  #warn(fields: Record<string, unknown>): void {
    this.#log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'WARN', message: 'trace export failed', ...fields }));
  }
}
