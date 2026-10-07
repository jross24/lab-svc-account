import { describe, expect, it } from 'vitest';
import { formatLogLine, levelForStatus } from '../lib/logger.ts';

const NOW = new Date('2026-10-07T20:15:30.123Z');

const FIELDS = {
  service: 'account',
  version: '1.2.3',
  requestId: 'req-1',
  route: 'GET /profile',
  status: 200,
  durationMs: 4.567,
} as const;

describe('formatLogLine', () => {
  it('makes one line of JSON with no line break', () => {
    const line = formatLogLine(FIELDS, NOW);
    expect(line).not.toContain('\n');
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it('has the timestamp, level, service, version, request id, route, status and duration', () => {
    const entry: unknown = JSON.parse(formatLogLine(FIELDS, NOW));
    expect(entry).toEqual({
      timestamp: '2026-10-07T20:15:30.123Z',
      level: 'INFO',
      service: 'account',
      version: '1.2.3',
      requestId: 'req-1',
      route: 'GET /profile',
      status: 200,
      durationMs: 4.567,
    });
  });

  it('adds the trace ID and the error message only when they exist', () => {
    const entry: unknown = JSON.parse(
      formatLogLine({ ...FIELDS, status: 500, traceId: '1-abc-def', error: 'boom' }, NOW),
    );
    expect(entry).toMatchObject({ level: 'ERROR', status: 500, traceId: '1-abc-def', error: 'boom' });
  });

  it('adds the field degraded only when there is a reason, and then the level is at least WARN', () => {
    const degraded = JSON.parse(formatLogLine({ ...FIELDS, degraded: 'catalogue: HTTP 503' }, NOW)) as Record<string, unknown>;
    expect(degraded).toMatchObject({ level: 'WARN', status: 200, degraded: 'catalogue: HTTP 503' });
    expect(JSON.parse(formatLogLine(FIELDS, NOW))).not.toHaveProperty('degraded');
    // A 5xx status stays ERROR.
    expect(JSON.parse(formatLogLine({ ...FIELDS, status: 502, degraded: 'x' }, NOW))).toMatchObject({ level: 'ERROR' });
  });

  it('adds the field coldStart only for a cold start', () => {
    expect(JSON.parse(formatLogLine({ ...FIELDS, coldStart: true }, NOW))).toMatchObject({ coldStart: true });
    expect(JSON.parse(formatLogLine({ ...FIELDS, coldStart: false }, NOW))).not.toHaveProperty('coldStart');
    expect(JSON.parse(formatLogLine(FIELDS, NOW))).not.toHaveProperty('coldStart');
  });

  it('rounds the duration to three decimals', () => {
    const entry = JSON.parse(formatLogLine({ ...FIELDS, durationMs: 1.23456789 }, NOW)) as { durationMs: number };
    expect(entry.durationMs).toBe(1.235);
  });
});

describe('levelForStatus', () => {
  it.each([
    [200, 'INFO'],
    [302, 'INFO'],
    [404, 'WARN'],
    [499, 'WARN'],
    [500, 'ERROR'],
    [503, 'ERROR'],
  ] as const)('maps status %i to %s', (status, level) => {
    expect(levelForStatus(status)).toBe(level);
  });
});
