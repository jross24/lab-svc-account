import { Duration } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { LambdaDeploymentConfig, LambdaDeploymentGroup } from 'aws-cdk-lib/aws-codedeploy';
import type { ILambdaDeploymentConfig } from 'aws-cdk-lib/aws-codedeploy';
import { Alias } from 'aws-cdk-lib/aws-lambda';
import type { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { METRIC_NAMESPACE } from './metrics.ts';

// How CodeDeploy moves the traffic of the alias "live" to a new version of the function.
// Every stage has the same CodeDeploy resources and the same alarms. Only this setting differs.
export type Release =
  // All the traffic goes to the new version at once. The alarms still stop a bad deployment.
  | { readonly kind: 'allAtOnce' }
  // The new version gets `percent` of the traffic. After `minutes` minutes it gets all the traffic.
  // CodeDeploy has a fixed list of canary configurations. The type allows only the one that the lab uses.
  | { readonly kind: 'canary'; readonly percent: 10; readonly minutes: 5 };

export const ALIAS_NAME = 'live';

const PERIOD = Duration.minutes(1);

export function deploymentConfigOf(release: Release): ILambdaDeploymentConfig {
  switch (release.kind) {
    case 'allAtOnce':
      return LambdaDeploymentConfig.ALL_AT_ONCE;
    case 'canary':
      // The type of Release allows only 10 percent and 5 minutes.
      return LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES;
  }
}

export interface GradualReleaseProps {
  readonly function: LambdaFunction;
  readonly release: Release;
  // The latency alarm fires when the p99 duration of the alias is over this value, in two periods in a row.
  // Each service chooses its own value from its own measurements. A service that calls another service waits
  // for that call, so its duration includes the time of the call.
  readonly latencyP99ThresholdMs: number;
  // Set this for a service that answers a failure with a 5xx status or with a degraded page, and does not throw.
  // Lambda counts a call as an error only when the function throws or times out. So the alarm on Lambda Errors
  // does not see a handled failure. This option adds a third alarm on the metric "errors" that the service writes
  // itself (see metrics.ts). The alarm watches "version", the version that this stack deploys. During a canary it
  // sees the errors of the new version only, and not the errors of the old version.
  readonly serviceErrors?: { readonly service: string; readonly version: string };
}

// The alias `live` of a function, the CodeDeploy deployment group that moves its traffic, and the two alarms
// that stop a bad deployment. The same alarms also serve the on-call: they watch the alias, which is the live traffic.
//
// CloudFormation starts a CodeDeploy deployment each time the version of the alias changes, and it waits for
// the end of the deployment. A firing alarm or a failed deployment rolls the traffic back, and the stack update fails.
// The first deployment of a stack creates the alias. A new alias has no earlier version, so it has no deployment.
export class GradualRelease extends Construct {
  readonly alias: Alias;
  readonly errorsAlarm: Alarm;
  readonly latencyAlarm: Alarm;
  readonly latencyP99ThresholdMs: number;
  // Only for a service that sets serviceErrors.
  readonly serviceErrorsAlarm?: Alarm;
  readonly deploymentGroup: LambdaDeploymentGroup;

  constructor(scope: Construct, id: string, props: GradualReleaseProps) {
    super(scope, id);

    // `currentVersion` publishes a new Lambda version when the function changes. The version number of
    // the release is in the environment of the function, so each release publishes a new version.
    this.latencyP99ThresholdMs = props.latencyP99ThresholdMs;

    this.alias = new Alias(this, 'Alias', {
      aliasName: ALIAS_NAME,
      version: props.function.currentVersion,
      description: 'The version that gets the live traffic',
    });

    // A quiet service has no data. Missing data is not a breach: a deployment does not wait for traffic,
    // and an idle night does not page anyone.
    this.errorsAlarm = new Alarm(this, 'ErrorsAlarm', {
      alarmDescription: 'The alias live had an error in the last minute. This alarm also stops a deployment.',
      metric: this.alias.metricErrors({ statistic: 'Sum', period: PERIOD }),
      threshold: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // Two periods in a row, so one slow call (for example the first call of a new version) does not stop a release.
    this.latencyAlarm = new Alarm(this, 'LatencyAlarm', {
      alarmDescription: `The p99 duration of the alias live was over ${props.latencyP99ThresholdMs} ms for two minutes. This alarm also stops a deployment.`,
      metric: this.alias.metricDuration({ statistic: 'p99', period: PERIOD }),
      threshold: props.latencyP99ThresholdMs,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    if (props.serviceErrors) {
      const { service, version } = props.serviceErrors;
      // The metric exists after the first request of the version. Until then the alarm has no data, and no data is not a breach.
      this.serviceErrorsAlarm = new Alarm(this, 'ServiceErrorsAlarm', {
        alarmDescription: `The version ${version} of ${service} counted an error in the last minute (a 5xx status or a degraded page). This alarm also stops a deployment.`,
        metric: new Metric({
          namespace: METRIC_NAMESPACE,
          metricName: 'errors',
          dimensionsMap: { service, version },
          statistic: 'Sum',
          period: PERIOD,
        }),
        threshold: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
    }

    // The default rollback settings roll back when the deployment fails and when an alarm fires.
    this.deploymentGroup = new LambdaDeploymentGroup(this, 'DeploymentGroup', {
      alias: this.alias,
      deploymentConfig: deploymentConfigOf(props.release),
      alarms: [this.errorsAlarm, this.latencyAlarm, ...(this.serviceErrorsAlarm ? [this.serviceErrorsAlarm] : [])],
    });
  }
}
