import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AccountStack } from '../lib/account-stack.ts';

function synth(version = '1.2.3', logRetentionDays = 7) {
  const stack = new AccountStack(new App(), 'Account', {
    version,
    config: { logRetentionDays, gradualRelease: false },
  });
  return { stack, template: Template.fromStack(stack) };
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
  const { stack, template } = synth();

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

  it('allows the function to invoke only the core API ARN from SSM', () => {
    template.resourceCountIs('AWS::IAM::Policy', 1);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'execute-api:Invoke',
            Effect: 'Allow',
            Resource: { Ref: ssmParameterId(template, '/lab/core/api-arn') },
          },
        ],
      },
    });
  });

  it('keeps the logs for the number of days in the stage config', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    synth('1.2.3', 30).template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
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
