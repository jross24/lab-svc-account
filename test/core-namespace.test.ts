import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { CloudFormationStackArtifact } from 'aws-cdk-lib/cx-api';
import { AccountStack } from '../lib/account-stack.ts';
import { createApp } from '../lib/app.ts';
import { coreNamesFor } from '../lib/namespace.ts';

// The context value coreNamespace is specific to this service: account is a consumer of core.
// The tests of the namespace of the service itself are in namespace.test.ts.

const VERSION_OF_A_PREVIEW = '0.0.0-pr12.abc1234';

interface TemplateShape {
  readonly Resources: Record<string, { readonly Type: string; readonly Properties?: Record<string, unknown> }>;
  readonly Parameters: Record<string, { readonly Type: string; readonly Default?: string }>;
}

function synthDev(context: Record<string, unknown>): CloudFormationStackArtifact {
  const assembly = createApp({ dev: 'true', ...context }).synth();
  expect(assembly.stacksRecursively).toHaveLength(1);
  return assembly.stacksRecursively[0] as CloudFormationStackArtifact;
}

// The SSM parameters that the stack reads: CloudFormation parameters of the type SSM, with the name as the default.
function readNames(stack: CloudFormationStackArtifact): string[] {
  return Object.values((stack.template as TemplateShape).Parameters)
    .filter((parameter) => parameter.Type === 'AWS::SSM::Parameter::Value<String>')
    .map((parameter) => parameter.Default as string)
    .filter((name) => name.startsWith('/lab/'))
    .sort();
}

describe('coreNamesFor', () => {
  it('gives the baseline parameters of core when there is no namespace of core', () => {
    expect(coreNamesFor()).toEqual({ urlParameterName: '/lab/core/url', apiArnParameterName: '/lab/core/api-arn' });
  });

  it('gives the parameters of a preview of core when core has a namespace', () => {
    expect(coreNamesFor('pr-21')).toEqual({
      urlParameterName: '/lab/ns/pr-21/core/url',
      apiArnParameterName: '/lab/ns/pr-21/core/api-arn',
    });
  });

  it.each(['', 'A', 'Pr-21', '1abc', 'abc-', 'a_b', 'abcdefghijklmnopqrstu', 12, true, null])(
    'refuses the value %j with a message that names coreNamespace',
    (value) => {
      expect(() => coreNamesFor(value as string)).toThrow(/coreNamespace must be 1 to 20 characters/);
      expect(() => coreNamesFor(value as string)).toThrow(/Example: -c coreNamespace=pr-21/);
    },
  );
});

describe('the app with a namespace and a namespace of core', () => {
  const stack = synthDev({ namespace: 'pr-12', coreNamespace: 'pr-21', version: VERSION_OF_A_PREVIEW });
  const template = stack.template as TemplateShape;

  it('reads the URL and the API ARN of core from /lab/ns/<core namespace>/core/', () => {
    expect(readNames(stack)).toEqual(['/lab/ns/pr-21/core/api-arn', '/lab/ns/pr-21/core/url']);
  });

  it('does not read the baseline parameters of core', () => {
    expect(JSON.stringify(template)).not.toContain('/lab/core/');
  });

  it('still writes its own parameters under its own namespace only', () => {
    const written = Object.values(template.Resources)
      .filter((resource) => resource.Type === 'AWS::SSM::Parameter')
      .map((resource) => resource.Properties?.Name as string)
      .sort();
    expect(written).toEqual(['/lab/ns/pr-12/account/url', '/lab/ns/pr-12/account/version']);
    expect(stack.stackName).toBe('lab-svc-account-pr-12');
  });

  it('gives the function the core URL and the policy the core API ARN from those parameters', () => {
    const parameters = Template.fromJSON(template as unknown as Record<string, unknown>).findParameters('*', {
      Type: 'AWS::SSM::Parameter::Value<String>',
    });
    const idOf = (name: string): string =>
      Object.entries(parameters).find(([, parameter]) => (parameter as { Default: string }).Default === name)?.[0] as string;
    const text = JSON.stringify(template);
    expect(text).toContain(`{"Ref":"${idOf('/lab/ns/pr-21/core/url')}"}`);
    expect(text).toContain(`{"Ref":"${idOf('/lab/ns/pr-21/core/api-arn')}"}`);
  });
});

describe('the app with a namespace of core and no namespace of its own', () => {
  it('stops: the baseline copy of account must not point at a preview of core', () => {
    expect(() => createApp({ dev: 'true', coreNamespace: 'pr-21' })).toThrow(
      /coreNamespace works only together with namespace/,
    );
  });
});

describe('a namespace of core without dev=true', () => {
  it.each([
    ['no dev value', {}],
    ['dev=false', { dev: 'false' }],
    ['dev as the boolean false', { dev: false }],
  ])('stops the app with %s', (_label, context) => {
    expect(() => createApp({ ...context, coreNamespace: 'pr-21' })).toThrow(
      /coreNamespace works only with dev=true/,
    );
  });

  it('stops the app even when the value is empty', () => {
    expect(() => createApp({ coreNamespace: '' })).toThrow(/coreNamespace works only with dev=true/);
  });
});

describe('an invalid namespace of core', () => {
  it.each(['', 'A', 'Pr-21', '1abc', '-abc', 'abc-', 'pr-', 'a_b', 'abcdefghijklmnopqrstu', 21, true, null])(
    'stops the app when dev=true and the value is %j',
    (coreNamespace) => {
      expect(() => createApp({ dev: 'true', namespace: 'pr-12', coreNamespace })).toThrow(
        /coreNamespace must be 1 to 20 characters/,
      );
    },
  );

  it('stops the stack too, when a caller skips the app', () => {
    expect(
      () =>
        new AccountStack(new App(), 'Account', {
          version: '1.2.3',
          config: { logRetentionDays: RetentionDays.ONE_WEEK, release: { kind: 'allAtOnce' }, injectFault: false, traceSampleRatio: 1 },
          namespace: 'pr-12',
          coreNamespace: 'Bad-Name',
        }),
    ).toThrow(/coreNamespace must be 1 to 20 characters/);
  });
});

describe('the app with no namespace of core', () => {
  // The synths run here, and not in a test, because the bundling of the function is slow on a busy machine.
  const pipeline = createApp().synth();
  const dev = synthDev({});
  const preview = synthDev({ namespace: 'pr-12' });

  it('reads the baseline parameters of core in every stage, with or without a namespace', () => {
    expect(pipeline.stacksRecursively).toHaveLength(3);
    for (const stack of pipeline.stacksRecursively) {
      expect(readNames(stack), stack.hierarchicalId).toEqual(['/lab/core/api-arn', '/lab/core/url']);
    }
    expect(readNames(dev)).toEqual(['/lab/core/api-arn', '/lab/core/url']);
    expect(readNames(preview)).toEqual(['/lab/core/api-arn', '/lab/core/url']);
  });

  it('makes the same template when the value is undefined', () => {
    const explicit = synthDev({ namespace: 'pr-12', coreNamespace: undefined });
    expect(explicit.template).toEqual(preview.template);
  });
});
