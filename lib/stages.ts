import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Release } from './gradual-release.ts';

// The settings that can differ between stages. All other things are the same in each stage.
export interface StageConfig {
  readonly logRetentionDays: RetentionDays;
  readonly release: Release;
  // A device for the release drill. When it is true, the function throws on each call.
  // Do not use it as a production practice. See "The Production drill" in the README.
  readonly injectFault: boolean;
  // The share of the new traces that are sampled, from 0 to 1. A request with a traceparent header follows its caller.
  // 1 samples all requests. See "Tracing" in the README for the cost.
  readonly traceSampleRatio: number;
}

// The pipeline deploys these stages. Each stage goes to its own AWS account.
export const STAGES = {
  Test: { logRetentionDays: RetentionDays.ONE_WEEK, release: { kind: 'allAtOnce' }, injectFault: false, traceSampleRatio: 1 },
  Staging: { logRetentionDays: RetentionDays.ONE_WEEK, release: { kind: 'allAtOnce' }, injectFault: false, traceSampleRatio: 1 },
  Production: {
    logRetentionDays: RetentionDays.ONE_MONTH,
    release: { kind: 'canary', percent: 10, minutes: 5 },
    injectFault: false,
    traceSampleRatio: 1,
  },
} as const satisfies Record<string, StageConfig>;

// A developer deploys this stage from a laptop to a personal account. The pipeline does not use it.
export const DEV_STAGE: StageConfig = {
  logRetentionDays: RetentionDays.THREE_DAYS,
  release: { kind: 'allAtOnce' },
  injectFault: false,
  traceSampleRatio: 1,
};
