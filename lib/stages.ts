import { RetentionDays } from 'aws-cdk-lib/aws-logs';

// The settings that can differ between stages. All other things are the same in each stage.
export interface StageConfig {
  readonly logRetentionDays: RetentionDays;
  // A placeholder. A later phase uses it to shift traffic to a new version in steps.
  readonly gradualRelease: boolean;
}

// The pipeline deploys these stages. Each stage goes to its own AWS account.
export const STAGES = {
  Test: { logRetentionDays: RetentionDays.ONE_WEEK, gradualRelease: false },
  Staging: { logRetentionDays: RetentionDays.ONE_WEEK, gradualRelease: false },
  Production: { logRetentionDays: RetentionDays.ONE_MONTH, gradualRelease: true },
} as const satisfies Record<string, StageConfig>;

// A developer deploys this stage from a laptop to a personal account. The pipeline does not use it.
export const DEV_STAGE: StageConfig = { logRetentionDays: RetentionDays.THREE_DAYS, gradualRelease: false };
