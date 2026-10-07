import { describe, expect, it } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { GradualRelease } from '../lib/gradual-release.ts';
import type { GradualReleaseProps } from '../lib/gradual-release.ts';

// The part of the release gate that a service can switch on: an alarm on the errors that the service counts itself.
function synth(serviceErrors?: GradualReleaseProps['serviceErrors']) {
  const stack = new Stack(new App(), 'Test');
  const fn = new LambdaFunction(stack, 'Fn', {
    runtime: Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: Code.fromInline('exports.handler = async () => ({})'),
  });
  const release = new GradualRelease(stack, 'Release', {
    function: fn,
    release: { kind: 'allAtOnce' },
    latencyP99ThresholdMs: 750,
    ...(serviceErrors ? { serviceErrors } : {}),
  });
  return { release, template: Template.fromStack(stack) };
}

describe('GradualRelease latency alarm', () => {
  it('uses the threshold that the service gives, and shows it on the construct', () => {
    const { release, template } = synth();
    expect(release.latencyP99ThresholdMs).toBe(750);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Duration', Threshold: 750 });
  });
});

describe('GradualRelease with no serviceErrors', () => {
  const { release, template } = synth();

  it('has two alarms, errors and latency, and no alarm on the errors that the service counts', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    expect(release.serviceErrorsAlarm).toBeUndefined();
  });
});

describe('GradualRelease with serviceErrors', () => {
  const { release, template } = synth({ service: 'catalogue', version: '1.2.3' });

  it('has a third alarm', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    expect(release.serviceErrorsAlarm).toBeDefined();
  });

  it('reads the metric errors of this service and of the version that the stack deploys', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'Lab/Service',
      MetricName: 'errors',
      Dimensions: Match.arrayEquals([
        { Name: 'service', Value: 'catalogue' },
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

  it('watches a different version in the next release, so the alarm sees the canary and not the old version', () => {
    const next = synth({ service: 'catalogue', version: '1.2.4' }).template;
    next.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'errors',
      Dimensions: Match.arrayWith([{ Name: 'version', Value: '1.2.4' }]),
    });
  });

  it('is one of the alarms that the deployment group watches', () => {
    const ids = Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'errors' } }));
    expect(ids).toHaveLength(1);
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      AlarmConfiguration: { Enabled: true, Alarms: Match.arrayWith([{ Name: { Ref: ids[0] } }]) },
    });
  });

  it('keeps the alarm on Lambda Errors of the alias and the alarm on the p99 duration', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'AWS/Lambda', MetricName: 'Errors' });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'AWS/Lambda', MetricName: 'Duration' });
  });
});
