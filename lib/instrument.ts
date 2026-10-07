import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { formatLogLine } from './logger.ts';
import { formatMetricLine } from './metrics.ts';

type Env = Record<string, string | undefined>;

export interface InstrumentOptions {
  readonly service: string;
  // The tests replace the four fields below. In Lambda the defaults are right.
  readonly env?: () => Env;
  readonly write?: (line: string) => void;
  // The clock for the duration, in milliseconds.
  readonly clock?: () => number;
  readonly now?: () => Date;
}

// Not console.log. The runtime of Lambda changes the output of console.log, and then the line is no
// longer JSON at the start. A direct write to stdout reaches CloudWatch Logs as it is.
function writeToStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

// Lambda sets _X_AMZN_TRACE_ID for each call, for example "Root=1-...;Parent=...;Sampled=1".
export function traceIdOf(env: Env): string | undefined {
  return /(?:^|;)Root=([^;]+)/.exec(env._X_AMZN_TRACE_ID ?? '')?.[1];
}

// A handler can report a failure that it handled and still answered with a good status. For example, a page can
// render with an error block because an upstream service failed. The user sees an error, but Lambda sees none.
// The handler sets "degraded" to a short reason. The wrapper then counts the call as an error and logs the reason.
export interface Signals {
  degraded?: string;
}

// Wraps a handler of an HTTP API (payload format 2.0). For each request it writes one log line and
// one metric line, also when the handler throws. A thrown error goes on to Lambda, because only
// then does the Errors metric of Lambda count the call, and that metric is the release gate.
// The metric line counts an error for a status of 500 or more, and for a call that the handler marked as degraded.
export function instrument<T extends { readonly statusCode: number }>(
  options: InstrumentOptions,
  handler: (event: APIGatewayProxyEventV2, context: Context, signals: Signals) => Promise<T>,
): (event: APIGatewayProxyEventV2, context: Context) => Promise<T> {
  const read = options.env ?? ((): Env => process.env);
  const write = options.write ?? writeToStdout;
  const clock = options.clock ?? ((): number => performance.now());
  const now = options.now ?? ((): Date => new Date());
  // Lambda loads the module one time for each execution environment, so this wrapper lives as long as the
  // environment. Its first request is the cold start.
  let firstRequest = true;

  return async (event, context) => {
    const coldStart = firstRequest;
    firstRequest = false;
    const started = clock();
    const signals: Signals = {};
    let status = 500;
    let error: string | undefined;
    try {
      const response = await handler(event, context, signals);
      status = response.statusCode;
      return response;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'unknown error';
      throw caught;
    } finally {
      const env = read();
      const version = env.VERSION ?? 'unknown';
      const durationMs = clock() - started;
      write(
        formatLogLine(
          {
            service: options.service,
            version,
            requestId: context.awsRequestId,
            route: event.routeKey,
            status,
            durationMs,
            traceId: traceIdOf(env),
            error,
            coldStart,
            degraded: signals.degraded,
          },
          now(),
        ),
      );
      write(
        formatMetricLine(
          { service: options.service, version, errors: status >= 500 || signals.degraded !== undefined ? 1 : 0, durationMs },
          now(),
        ),
      );
    }
  };
}
