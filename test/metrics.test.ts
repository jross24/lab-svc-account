import { describe, expect, it } from 'vitest';
import { METRIC_NAMESPACE, formatMetricLine } from '../lib/metrics.ts';

const NOW = new Date('2026-10-07T20:15:30.123Z');

interface Emf {
  readonly _aws: {
    readonly Timestamp: number;
    readonly CloudWatchMetrics: readonly {
      readonly Namespace: string;
      readonly Dimensions: readonly (readonly string[])[];
      readonly Metrics: readonly { readonly Name: string; readonly Unit: string }[];
    }[];
  };
  readonly [key: string]: unknown;
}

function emf(fields: { errors: 0 | 1; durationMs: number }): Emf {
  return JSON.parse(formatMetricLine({ service: 'account', version: '1.2.3', ...fields }, NOW)) as Emf;
}

describe('formatMetricLine', () => {
  it('makes one line of JSON with no line break', () => {
    const line = formatMetricLine({ service: 'account', version: '1.2.3', errors: 0, durationMs: 5 }, NOW);
    expect(line).not.toContain('\n');
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it('has the _aws block of the CloudWatch embedded metric format', () => {
    const line = emf({ errors: 0, durationMs: 5 });
    expect(line._aws.Timestamp).toBe(NOW.getTime());
    expect(line._aws.CloudWatchMetrics).toHaveLength(1);
    expect(line._aws.CloudWatchMetrics[0]).toEqual({
      Namespace: METRIC_NAMESPACE,
      Dimensions: [['service', 'version']],
      Metrics: [
        { Name: 'requests', Unit: 'Count' },
        { Name: 'errors', Unit: 'Count' },
        { Name: 'duration', Unit: 'Milliseconds' },
      ],
    });
  });

  it('has the dimension values and the metric values at the top level', () => {
    expect(emf({ errors: 0, durationMs: 5 })).toMatchObject({
      service: 'account',
      version: '1.2.3',
      requests: 1,
      errors: 0,
      duration: 5,
    });
  });

  it('counts one error for a failed request', () => {
    expect(emf({ errors: 1, durationMs: 5 })).toMatchObject({ requests: 1, errors: 1 });
  });

  it('gives every metric and every dimension of the _aws block a value at the top level', () => {
    const line = emf({ errors: 0, durationMs: 5 });
    for (const metric of line._aws.CloudWatchMetrics[0]?.Metrics ?? []) {
      expect(typeof line[metric.Name]).toBe('number');
    }
    for (const dimension of line._aws.CloudWatchMetrics[0]?.Dimensions[0] ?? []) {
      expect(typeof line[dimension]).toBe('string');
    }
  });
});
