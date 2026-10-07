import { roundMs } from './logger.ts';

// The namespace of the custom metrics in CloudWatch. The dashboard reads the same name.
export const METRIC_NAMESPACE = 'Lab/Service';

export interface MetricFields {
  readonly service: string;
  readonly version: string;
  readonly errors: 0 | 1;
  readonly durationMs: number;
}

// One request is one line in the CloudWatch embedded metric format (EMF).
// CloudWatch reads the line from the log stream and makes the metrics. The function needs no
// PutMetricData permission, and the pipeline needs no new permission.
// The dimension "version" is the release. So a graph of the requests by version shows when
// each release took traffic.
export function formatMetricLine(fields: MetricFields, now: Date = new Date()): string {
  return JSON.stringify({
    _aws: {
      Timestamp: now.getTime(),
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [['service', 'version']],
          Metrics: [
            { Name: 'requests', Unit: 'Count' },
            { Name: 'errors', Unit: 'Count' },
            { Name: 'duration', Unit: 'Milliseconds' },
          ],
        },
      ],
    },
    service: fields.service,
    version: fields.version,
    requests: 1,
    errors: fields.errors,
    duration: roundMs(fields.durationMs),
  });
}
