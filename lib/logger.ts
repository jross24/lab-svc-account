export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface LogFields {
  readonly service: string;
  readonly version: string;
  readonly requestId: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  // The X-Ray trace of the request. It links a log line to its trace.
  readonly traceId?: string | undefined;
  readonly error?: string | undefined;
  // True for the first request of an execution environment. The init time of the function falls on that request.
  readonly coldStart?: boolean | undefined;
  // The reason, when the handler answered with a good status but handled a failure. See Signals in instrument.ts.
  readonly degraded?: string | undefined;
  // The value of each flag that the handler used for this request, where the values came from, and whether a request
  // header overrode them. The three fields come together. A handler that reads no flags writes none of them.
  readonly flags?: Readonly<Record<string, boolean>> | undefined;
  readonly flagsSource?: 'appconfig' | 'default' | undefined;
  readonly flagsOverridden?: boolean | undefined;
}

export function levelForStatus(status: number): LogLevel {
  if (status >= 500) return 'ERROR';
  if (status >= 400) return 'WARN';
  return 'INFO';
}

// Three decimals are enough for a duration in milliseconds.
export function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// One request is one line of JSON. CloudWatch Logs Insights then finds each field with no parse rule.
// The line has no request body, no header and no query string, so it holds no personal data.
export function formatLogLine(fields: LogFields, now: Date = new Date()): string {
  const { traceId, error, durationMs, coldStart, degraded, flags, flagsSource, flagsOverridden, ...rest } = fields;
  return JSON.stringify({
    timestamp: now.toISOString(),
    // A degraded answer with a good status is a warning. A status of 400 or more keeps its own level.
    level: degraded !== undefined && fields.status < 400 ? 'WARN' : levelForStatus(fields.status),
    ...rest,
    durationMs: roundMs(durationMs),
    ...(traceId === undefined ? {} : { traceId }),
    ...(error === undefined ? {} : { error }),
    ...(coldStart === true ? { coldStart } : {}),
    ...(degraded === undefined ? {} : { degraded }),
    ...(flags === undefined ? {} : { flags, flagsSource, flagsOverridden }),
  });
}
