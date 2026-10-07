import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { AccountStack, FUNCTION_TIMEOUT, LATENCY_P99_THRESHOLD_MS } from '../lib/account-stack.ts';
import type { StageConfig } from '../lib/stages.ts';

const ALL_AT_ONCE: StageConfig['release'] = { kind: 'allAtOnce' };
const CANARY: StageConfig['release'] = { kind: 'canary', percent: 10, minutes: 5 };

// The p99 duration of a warm call, measured in Test on 2026-10-07 (see "Where the latency threshold comes from" in the README).
const MEASURED_WARM_P99_MS = 914;

function synth(version = '1.2.3', config: Partial<StageConfig> = {}) {
  const stack = new AccountStack(new App(), 'Account', {
    version,
    config: { logRetentionDays: RetentionDays.ONE_WEEK, release: ALL_AT_ONCE, injectFault: false, ...config },
  });
  return { stack, template: Template.fromStack(stack) };
}

// Each synth bundles the function with esbuild and takes a second or more. So this file builds each stack one time.
const base = synth();
const again = synth();
const nextRelease = synth('1.2.4');
const canary = synth('1.2.3', { release: CANARY });
const monthly = synth('1.2.3', { logRetentionDays: RetentionDays.ONE_MONTH });
const faulty = synth('1.2.3', { injectFault: true });

function onlyKey(resources: Record<string, unknown>): string {
  const keys = Object.keys(resources);
  expect(keys).toHaveLength(1);
  return keys[0] ?? '';
}

// The logical ID of the CloudFormation parameter that reads one SSM parameter at deployment.
function ssmParameterId(template: Template, name: string): string {
  const ids = Object.keys(
    template.findParameters('*', { Type: 'AWS::SSM::Parameter::Value<String>', Default: name }),
  );
  expect(ids).toHaveLength(1);
  return ids[0] as string;
}

describe('AccountStack', () => {
  const { stack, template } = base;

  it('has a fixed stack name and no fixed account or region', () => {
    expect(stack.stackName).toBe('lab-svc-account');
    expect(stack.resolve(stack.account)).toEqual({ Ref: 'AWS::AccountId' });
    expect(stack.resolve(stack.region)).toEqual({ Ref: 'AWS::Region' });
  });

  it('reads the two SSM parameters of core at deployment, not at synth', () => {
    ssmParameterId(template, '/lab/core/url');
    ssmParameterId(template, '/lab/core/api-arn');
  });

  it('has one Node.js 22 function that gets the version and the core URL from the environment', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Timeout: 10,
      Environment: {
        Variables: { VERSION: '1.2.3', CORE_URL: { Ref: ssmParameterId(template, '/lab/core/url') } },
      },
    });
  });

  it('keeps the timeout of the function at 10 seconds', () => {
    expect(FUNCTION_TIMEOUT.toSeconds()).toBe(10);
  });

  it('allows the function to invoke only the core API ARN from SSM, and to send segments to X-Ray', () => {
    // The alias runs with the role of the function. So this one policy serves the alias too.
    template.resourceCountIs('AWS::IAM::Policy', 1);
    const [policy] = Object.values(template.findResources('AWS::IAM::Policy')) as {
      Properties: { PolicyDocument: { Statement: { Action: unknown; Effect: string; Resource: unknown }[] } };
    }[];
    const statements = policy?.Properties.PolicyDocument.Statement ?? [];
    expect(statements).toHaveLength(2);
    expect(statements).toContainEqual({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: { Ref: ssmParameterId(template, '/lab/core/api-arn') },
    });
    expect(statements).toContainEqual({
      Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      Effect: 'Allow',
      Resource: '*',
    });
  });

  it('keeps the logs for the number of days in the stage config', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    monthly.template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  it('has one public route, GET /profile, with no authoriser', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /profile',
      AuthorizationType: 'NONE',
      AuthorizerId: Match.absent(),
    });
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 0);
  });

  it('writes its own API URL to the SSM parameter /lab/account/url', () => {
    const apiId = Object.keys(template.findResources('AWS::ApiGatewayV2::Api'))[0];
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/account/url',
      Type: 'String',
      // CloudFormation returns the endpoint as https://<api-id>.execute-api.<region>.amazonaws.com
      Value: { 'Fn::GetAtt': [apiId, 'ApiEndpoint'] },
    });
    template.resourceCountIs('AWS::SSM::Parameter', 1);
  });

  it('reports the version and the API URL as stack outputs', () => {
    template.hasOutput('Version', { Value: '1.2.3' });
    template.hasOutput('ApiUrl', { Value: Match.anyValue() });
  });

  it('has no output that contains the account ID or the core API ARN', () => {
    // The deploy job prints the outputs to a public log. The core API ARN contains the account ID.
    const outputs = JSON.stringify(template.findOutputs('*'));
    expect(outputs).not.toContain('AWS::AccountId');
    expect(outputs).not.toContain(ssmParameterId(template, '/lab/core/api-arn'));
  });
});

describe('the alias live', () => {
  const { template } = base;
  const versionId = onlyKey(template.findResources('AWS::Lambda::Version'));
  const aliasId = onlyKey(template.findResources('AWS::Lambda::Alias'));

  it('points at one published version of the function', () => {
    const functionId = onlyKey(template.findResources('AWS::Lambda::Function'));
    template.hasResourceProperties('AWS::Lambda::Version', { FunctionName: { Ref: functionId } });
    template.hasResourceProperties('AWS::Lambda::Alias', {
      Name: 'live',
      FunctionName: { Ref: functionId },
      FunctionVersion: { 'Fn::GetAtt': [versionId, 'Version'] },
    });
  });

  it('is the target of the API integration, so the API calls the alias and not the function', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: { Ref: aliasId },
    });
  });

  it('is the only target of the invoke permission of the API', () => {
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission'));
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({
      Properties: { Action: 'lambda:InvokeFunction', FunctionName: { Ref: aliasId }, Principal: 'apigateway.amazonaws.com' },
    });
  });

  it('is the target of the invoke permission before the integration calls it', () => {
    // The update of a running stack must not leave a moment where the API calls the alias without a permission.
    const permissionId = onlyKey(template.findResources('AWS::Lambda::Permission'));
    template.hasResource('AWS::ApiGatewayV2::Integration', { DependsOn: Match.arrayWith([permissionId]) });
  });

  it('makes every integration of the API depend on every invoke permission of the API', () => {
    // A stack with more routes has more permissions and more integrations. The dependency must cover all of them.
    const permissions = Object.keys(template.findResources('AWS::Lambda::Permission'));
    const integrations = Object.entries(template.findResources('AWS::ApiGatewayV2::Integration'));
    expect(permissions.length).toBeGreaterThan(0);
    expect(integrations.length).toBeGreaterThan(0);
    for (const [id, integration] of integrations) {
      expect((integration as { DependsOn?: string[] }).DependsOn, id).toEqual(expect.arrayContaining(permissions));
    }
  });

  it('gets a new published version for each release', () => {
    expect(Object.keys(nextRelease.template.findResources('AWS::Lambda::Version'))).not.toEqual([versionId]);
  });

  it('keeps the same published version when nothing changes', () => {
    expect(Object.keys(again.template.findResources('AWS::Lambda::Version'))).toEqual([versionId]);
  });
});

describe('the deployment group', () => {
  const { template } = base;

  it('is one CodeDeploy application and one deployment group on the Lambda platform', () => {
    template.resourceCountIs('AWS::CodeDeploy::Application', 1);
    template.hasResourceProperties('AWS::CodeDeploy::Application', { ComputePlatform: 'Lambda' });
    template.resourceCountIs('AWS::CodeDeploy::DeploymentGroup', 1);
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentStyle: { DeploymentOption: 'WITH_TRAFFIC_CONTROL', DeploymentType: 'BLUE_GREEN' },
    });
  });

  it('is the update policy of the alias, so each new version of the alias starts a deployment', () => {
    const groupId = onlyKey(template.findResources('AWS::CodeDeploy::DeploymentGroup'));
    const applicationId = onlyKey(template.findResources('AWS::CodeDeploy::Application'));
    template.hasResource('AWS::Lambda::Alias', {
      UpdatePolicy: {
        CodeDeployLambdaAliasUpdate: {
          ApplicationName: { Ref: applicationId },
          DeploymentGroupName: { Ref: groupId },
        },
      },
    });
  });

  it('uses the all-at-once configuration for the release all at once', () => {
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentConfigName: 'CodeDeployDefault.LambdaAllAtOnce',
    });
  });

  it('uses the canary configuration for the release canary 10 percent, 5 minutes', () => {
    canary.template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentConfigName: 'CodeDeployDefault.LambdaCanary10Percent5Minutes',
    });
  });

  it('creates no extra deployment configuration', () => {
    canary.template.resourceCountIs('AWS::CodeDeploy::DeploymentConfig', 0);
  });

  it('rolls back when the deployment fails and when an alarm fires', () => {
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      AutoRollbackConfiguration: {
        Enabled: true,
        Events: Match.arrayWith(['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_ALARM']),
      },
    });
  });

  it('watches all three alarms and stops when it cannot read an alarm', () => {
    const errorsId = Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'Errors' } }));
    const latencyId = Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'Duration' } }));
    const serviceErrorsId = Object.keys(
      template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'errors' } }),
    );
    expect(errorsId).toHaveLength(1);
    expect(latencyId).toHaveLength(1);
    expect(serviceErrorsId).toHaveLength(1);
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      AlarmConfiguration: {
        Enabled: true,
        // The default is false: CodeDeploy stops the deployment when it cannot read an alarm.
        IgnorePollAlarmFailure: Match.absent(),
        Alarms: Match.arrayEquals([
          { Name: { Ref: errorsId[0] } },
          { Name: { Ref: latencyId[0] } },
          { Name: { Ref: serviceErrorsId[0] } },
        ]),
      },
    });
  });
});

describe('the alarms', () => {
  const { template } = base;

  it('has exactly three alarms: errors, latency and the errors that the service counts', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  });

  it('fires on any error in a period of one minute, and a quiet service does not fire it', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Statistic: 'Sum',
      Period: 60,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('fires when the p99 duration is over the threshold in two periods in a row', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Lambda',
      MetricName: 'Duration',
      ExtendedStatistic: 'p99',
      Period: 60,
      EvaluationPeriods: 2,
      DatapointsToAlarm: 2,
      Threshold: LATENCY_P99_THRESHOLD_MS,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('keeps the latency threshold well above a warm call and below a third of the timeout of the function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { Timeout: FUNCTION_TIMEOUT.toSeconds() });
    // The duration includes the signed call to core. The README shows the measurement.
    expect(LATENCY_P99_THRESHOLD_MS).toBeGreaterThanOrEqual(2 * MEASURED_WARM_P99_MS);
    expect(LATENCY_P99_THRESHOLD_MS).toBeLessThanOrEqual(FUNCTION_TIMEOUT.toMilliseconds() / 3);
  });

  it('fires on the metric errors of this service and of the version that the stack deploys', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'Lab/Service',
      MetricName: 'errors',
      Dimensions: Match.arrayEquals([
        { Name: 'service', Value: 'account' },
        { Name: 'version', Value: '1.2.3' },
      ]),
      Statistic: 'Sum',
      Period: 60,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('watches the version of the next release in the next release', () => {
    nextRelease.template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'errors',
      Dimensions: Match.arrayWith([{ Name: 'version', Value: '1.2.4' }]),
    });
  });

  it('watches the alias live with the two Lambda alarms, so they see live traffic and not the other versions', () => {
    const alarms = Object.values(
      template.findResources('AWS::CloudWatch::Alarm', { Properties: { Namespace: 'AWS/Lambda' } }),
    ) as { Properties: { Dimensions: { Name: string; Value: unknown }[] } }[];
    expect(alarms).toHaveLength(2);
    for (const alarm of alarms) {
      const names = alarm.Properties.Dimensions.map((dimension) => dimension.Name).sort();
      expect(names).toEqual(['FunctionName', 'Resource']);
      const resource = alarm.Properties.Dimensions.find((dimension) => dimension.Name === 'Resource');
      expect(JSON.stringify(resource?.Value)).toContain(':live');
    }
  });

  it('has no notification target in the lab', () => {
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')) as {
      Properties: { AlarmActions?: unknown; OKActions?: unknown; InsufficientDataActions?: unknown };
    }[];
    for (const alarm of alarms) {
      expect(alarm.Properties.AlarmActions).toBeUndefined();
      expect(alarm.Properties.OKActions).toBeUndefined();
      expect(alarm.Properties.InsufficientDataActions).toBeUndefined();
    }
    template.resourceCountIs('AWS::SNS::Topic', 0);
  });
});

describe('tracing', () => {
  const { template } = base;

  it('turns on active tracing of the function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { TracingConfig: { Mode: 'Active' } });
  });

  it('lets the function role send segments to X-Ray', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('uses no Lambda layer', () => {
    const functions = Object.values(template.findResources('AWS::Lambda::Function')) as {
      Properties: { Layers?: unknown };
    }[];
    expect(functions[0]?.Properties.Layers).toBeUndefined();
  });
});

describe('the fault switch', () => {
  it('sets no INJECT_FAULT variable when the stage config does not inject a fault', () => {
    const functions = Object.values(base.template.findResources('AWS::Lambda::Function')) as {
      Properties: { Environment: { Variables: Record<string, unknown> } };
    }[];
    expect(functions[0]?.Properties.Environment.Variables).not.toHaveProperty('INJECT_FAULT');
  });

  it('sets INJECT_FAULT to true when the stage config injects a fault, and keeps the other variables', () => {
    const { template } = faulty;
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          INJECT_FAULT: 'true',
          VERSION: '1.2.3',
          CORE_URL: { Ref: ssmParameterId(template, '/lab/core/url') },
        },
      },
    });
  });

  it('publishes a new version when the stage config turns the fault on', () => {
    const off = Object.keys(base.template.findResources('AWS::Lambda::Version'));
    const on = Object.keys(faulty.template.findResources('AWS::Lambda::Version'));
    expect(on).not.toEqual(off);
  });
});

interface Widget {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly properties: {
    readonly title?: string;
    readonly stacked?: boolean;
    readonly metrics?: readonly (readonly unknown[])[];
    readonly alarms?: readonly string[];
    readonly annotations?: { readonly horizontal?: readonly { readonly value: number }[] };
  };
}

// CloudFormation fills the tokens of the dashboard body (Ref and GetAtt) when it deploys. In the test, each
// token becomes a marker such as <Ref:Name> or <GetAtt:Name.Arn>. Then the body is a plain JSON text.
function dashboardWidgets(template: Template): Widget[] {
  const [dashboard] = Object.values(template.findResources('AWS::CloudWatch::Dashboard')) as {
    Properties: { DashboardBody: { 'Fn::Join': [string, unknown[]] } };
  }[];
  const parts = dashboard?.Properties.DashboardBody['Fn::Join'][1] ?? [];
  const text = parts
    .map((part) => {
      if (typeof part === 'string') return part;
      const token = part as { Ref?: string; 'Fn::GetAtt'?: string[] };
      return token.Ref ? `<Ref:${token.Ref}>` : `<GetAtt:${(token['Fn::GetAtt'] ?? []).join('.')}>`;
    })
    .join('');
  return (JSON.parse(text) as { widgets: Widget[] }).widgets;
}

describe('the dashboard', () => {
  const { template } = base;
  const widgets = dashboardWidgets(template);
  const widget = (title: string): Widget => {
    const found = widgets.find((candidate) => candidate.properties.title === title);
    expect(found, title).toBeDefined();
    return found as Widget;
  };
  const functionId = onlyKey(template.findResources('AWS::Lambda::Function'));
  const apiId = onlyKey(template.findResources('AWS::ApiGatewayV2::Api'));

  it('is one dashboard with a fixed name', () => {
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', { DashboardName: 'lab-svc-account' });
  });

  it('has a text widget, five metric widgets and an alarm widget, all inside the 24 columns of the grid', () => {
    expect(widgets.map((candidate) => candidate.type).sort()).toEqual([
      'alarm',
      'metric',
      'metric',
      'metric',
      'metric',
      'metric',
      'text',
    ]);
    for (const candidate of widgets) {
      expect(candidate.x).toBeGreaterThanOrEqual(0);
      expect(candidate.x + candidate.width).toBeLessThanOrEqual(24);
      expect(candidate.height).toBeGreaterThan(0);
    }
  });

  it('shows the requests by version from the embedded metrics, one line for each version', () => {
    const requests = widget('Requests by version');
    expect(requests.properties.stacked).toBe(true);
    expect(requests.properties.metrics).toEqual([
      [
        {
          expression: `SEARCH('{Lab/Service,service,version} service="account" MetricName="requests"', 'Sum', 60)`,
          period: 60,
        },
      ],
    ]);
  });

  it('shows the errors that the service counted, one line for each version', () => {
    const errors = widget('Errors that the service counted, by version');
    expect(errors.properties.stacked).toBe(true);
    expect(errors.properties.metrics).toEqual([
      [
        {
          expression: `SEARCH('{Lab/Service,service,version} service="account" MetricName="errors"', 'Sum', 60)`,
          period: 60,
        },
      ],
    ]);
  });

  it('shows the errors of the alias live, with the line of the alarm', () => {
    const errors = widget('Errors of the alias live');
    expect(errors.properties.metrics).toEqual([
      [
        'AWS/Lambda',
        'Errors',
        'FunctionName',
        `<Ref:${functionId}>`,
        'Resource',
        `<Ref:${functionId}>:live`,
        { label: 'Lambda errors', period: 60, stat: 'Sum' },
      ],
    ]);
    expect(errors.properties.annotations?.horizontal?.map((line) => line.value)).toEqual([1]);
  });

  it('shows the p50 and the p99 duration of the alias live, with the line of the alarm', () => {
    const duration = widget('Duration of the alias live');
    expect(duration.properties.metrics?.map((metric) => metric.slice(0, 6))).toEqual([
      ['AWS/Lambda', 'Duration', 'FunctionName', `<Ref:${functionId}>`, 'Resource', `<Ref:${functionId}>:live`],
      ['AWS/Lambda', 'Duration', 'FunctionName', `<Ref:${functionId}>`, 'Resource', `<Ref:${functionId}>:live`],
    ]);
    expect(duration.properties.metrics?.map((metric) => (metric[6] as { stat: string }).stat)).toEqual(['p50', 'p99']);
    expect(duration.properties.annotations?.horizontal?.map((line) => line.value)).toEqual([LATENCY_P99_THRESHOLD_MS]);
  });

  it('shows the 4xx and the 5xx of API Gateway for this API', () => {
    const gateway = widget('API Gateway 4xx and 5xx');
    expect(gateway.properties.metrics?.map((metric) => metric.slice(0, 4))).toEqual([
      ['AWS/ApiGateway', '4xx', 'ApiId', `<Ref:${apiId}>`],
      ['AWS/ApiGateway', '5xx', 'ApiId', `<Ref:${apiId}>`],
    ]);
  });

  it('shows the state of all three alarms: errors, latency and then the errors that the service counted', () => {
    const errorsAlarm = Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'Errors' } }));
    const latencyAlarm = Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'Duration' } }));
    const serviceAlarm = Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'errors' } }));
    const alarmWidget = widgets.find((candidate) => candidate.type === 'alarm');
    expect(alarmWidget?.properties.alarms).toEqual([
      `<GetAtt:${errorsAlarm[0]}.Arn>`,
      `<GetAtt:${latencyAlarm[0]}.Arn>`,
      `<GetAtt:${serviceAlarm[0]}.Arn>`,
    ]);
  });
});
