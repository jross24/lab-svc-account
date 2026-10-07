import { Duration } from 'aws-cdk-lib';
import type { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import {
  AlarmStatusWidget,
  Dashboard,
  GraphWidget,
  MathExpression,
  TextWidget,
} from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import type { GradualRelease } from './gradual-release.ts';
import { METRIC_NAMESPACE } from './metrics.ts';

const PERIOD = Duration.minutes(1);
const HALF = 12;
const FULL = 24;
const HEIGHT = 6;

export interface ServiceDashboardProps {
  readonly service: string;
  readonly release: GradualRelease;
  readonly api: HttpApi;
}

// One dashboard in the account of the stage. It has the signals that decide a release and the signals
// that an on-call needs.
export class ServiceDashboard extends Construct {
  readonly dashboard: Dashboard;

  constructor(scope: Construct, id: string, props: ServiceDashboardProps) {
    super(scope, id);
    const { service, release, api } = props;
    const alias = release.alias;

    // A SEARCH expression makes one line for each value of the dimension "version". A new release adds
    // a new line by itself, and the code does not name any version.
    const requestsByVersion = new MathExpression({
      expression: `SEARCH('{${METRIC_NAMESPACE},service,version} service="${service}" MetricName="requests"', 'Sum', 60)`,
      label: '',
      period: PERIOD,
    });

    const errorsByVersion = new MathExpression({
      expression: `SEARCH('{${METRIC_NAMESPACE},service,version} service="${service}" MetricName="errors"', 'Sum', 60)`,
      label: '',
      period: PERIOD,
    });

    this.dashboard = new Dashboard(this, 'Dashboard', {
      dashboardName: `lab-svc-${service}`,
      defaultInterval: Duration.hours(3),
    });

    this.dashboard.addWidgets(
      new TextWidget({
        width: FULL,
        height: 3,
        markdown: [
          `## ${service}: release and health`,
          'The first graph shows the requests of each release. In Production a new version first gets 10 percent of the requests for 5 minutes. In Test and Staging it gets all of them at once.',
          'Both alarms watch the alias `live`. An alarm in the state ALARM stops a deployment and rolls the traffic back.',
        ].join('\n\n'),
      }),
      new GraphWidget({
        title: 'Requests by version',
        width: HALF,
        height: HEIGHT,
        stacked: true,
        left: [requestsByVersion],
        leftYAxis: { min: 0, label: 'requests per minute', showUnits: false },
      }),
      new GraphWidget({
        title: 'Errors of the alias live',
        width: HALF,
        height: HEIGHT,
        left: [alias.metricErrors({ statistic: 'Sum', period: PERIOD, label: 'Lambda errors' })],
        leftAnnotations: [release.errorsAlarm.toAnnotation()],
        leftYAxis: { min: 0, showUnits: false },
      }),
      new GraphWidget({
        title: 'Duration of the alias live',
        width: HALF,
        height: HEIGHT,
        left: [
          alias.metricDuration({ statistic: 'p50', period: PERIOD, label: 'p50' }),
          alias.metricDuration({ statistic: 'p99', period: PERIOD, label: 'p99' }),
        ],
        leftAnnotations: [
          { value: release.latencyP99ThresholdMs, label: 'p99 alarm threshold', color: '#d62728' },
        ],
        leftYAxis: { min: 0, label: 'ms', showUnits: false },
      }),
      new GraphWidget({
        title: 'API Gateway 4xx and 5xx',
        width: HALF,
        height: HEIGHT,
        left: [
          api.metricClientError({ statistic: 'Sum', period: PERIOD, label: '4xx' }),
          api.metricServerError({ statistic: 'Sum', period: PERIOD, label: '5xx' }),
        ],
        leftYAxis: { min: 0, showUnits: false },
      }),
    );

    // A service that sets serviceErrors counts its own errors (a 5xx status or a degraded page). Lambda does not.
    if (release.serviceErrorsAlarm) {
      this.dashboard.addWidgets(
        new GraphWidget({
          title: 'Errors that the service counted, by version',
          width: HALF,
          height: HEIGHT,
          stacked: true,
          left: [errorsByVersion],
          leftYAxis: { min: 0, showUnits: false },
        }),
      );
    }

    this.dashboard.addWidgets(
      new AlarmStatusWidget({
        title: 'Alarms: the release gate and the on-call',
        width: FULL,
        height: 3,
        alarms: [
          release.errorsAlarm,
          release.latencyAlarm,
          ...(release.serviceErrorsAlarm ? [release.serviceErrorsAlarm] : []),
        ],
      }),
    );
  }
}
