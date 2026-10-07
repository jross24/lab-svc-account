import { describe, expect, it } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { GradualRelease } from '../lib/gradual-release.ts';
import type { GradualReleaseProps } from '../lib/gradual-release.ts';
import { ServiceDashboard } from '../lib/service-dashboard.ts';

interface Widget {
  readonly type: string;
  readonly properties: {
    readonly title?: string;
    readonly stacked?: boolean;
    readonly metrics?: readonly (readonly unknown[])[];
    readonly alarms?: readonly string[];
  };
}

// The dashboard body holds tokens (Ref and GetAtt). Each token becomes a marker, so the body is a plain JSON text.
function widgetsOf(template: Template): Widget[] {
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
  new ServiceDashboard(stack, 'Dashboard', { service: 'catalogue', release, api: new HttpApi(stack, 'Api') });
  return Template.fromStack(stack);
}

describe('the dashboard without serviceErrors', () => {
  const widgets = widgetsOf(synth());

  it('has no graph of the errors that the service counted, and two alarms in the alarm widget', () => {
    expect(widgets.map((widget) => widget.properties.title)).not.toContain('Errors that the service counted, by version');
    expect(widgets.find((widget) => widget.type === 'alarm')?.properties.alarms).toHaveLength(2);
  });
});

describe('the dashboard with serviceErrors', () => {
  const template = synth({ service: 'catalogue', version: '1.2.3' });
  const widgets = widgetsOf(template);

  it('has a graph of the errors that the service counted, one line for each version', () => {
    const graph = widgets.find((widget) => widget.properties.title === 'Errors that the service counted, by version');
    expect(graph?.properties.stacked).toBe(true);
    expect(graph?.properties.metrics).toEqual([
      [
        {
          expression: `SEARCH('{Lab/Service,service,version} service="catalogue" MetricName="errors"', 'Sum', 60)`,
          period: 60,
        },
      ],
    ]);
  });

  it('shows all three alarms in the alarm widget, the service errors alarm last', () => {
    const serviceAlarm = Object.keys(
      template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'errors' } }),
    );
    const alarms = widgets.find((widget) => widget.type === 'alarm')?.properties.alarms ?? [];
    expect(alarms).toHaveLength(3);
    expect(alarms[2]).toBe(`<GetAtt:${serviceAlarm[0]}.Arn>`);
  });
});
