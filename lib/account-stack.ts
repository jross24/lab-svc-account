import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import type { StageConfig } from './stages.ts';

const PROFILE_PATH = '/profile';

export interface AccountStackProps {
  readonly version: string;
  readonly config: StageConfig;
}

export class AccountStack extends Stack {
  constructor(scope: Construct, id: string, props: AccountStackProps) {
    // No env here: the stack takes the account and the region of the credentials that deploy it.
    super(scope, id, { stackName: 'lab-svc-account' });

    // The core service writes these two parameters in each account.
    // CloudFormation reads them at deployment, so one synth serves each account.
    // So core must be in an account before this stack can go there.
    const coreUrl = StringParameter.valueForStringParameter(this, '/lab/core/url');
    const coreApiArn = StringParameter.valueForStringParameter(this, '/lab/core/api-arn');

    const profileFunction = new NodejsFunction(this, 'ProfileFunction', {
      entry: fileURLToPath(new URL('./profile-handler.ts', import.meta.url)),
      runtime: Runtime.NODEJS_22_X,
      // The function waits for core, and core can have a cold start.
      timeout: Duration.seconds(10),
      environment: { VERSION: props.version, CORE_URL: coreUrl },
      logGroup: new LogGroup(this, 'ProfileFunctionLogs', {
        retention: props.config.logRetentionDays,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    // The API of core uses IAM authorisation. This is the only permission that the function needs for it.
    profileFunction.addToRolePolicy(
      new PolicyStatement({ actions: ['execute-api:Invoke'], resources: [coreApiArn] }),
    );

    const api = new HttpApi(this, 'Api', { description: 'lab-svc-account: mock public API' });

    // No authoriser: the route is public.
    api.addRoutes({
      path: PROFILE_PATH,
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('ProfileIntegration', profileFunction),
    });

    // The web application reads this parameter to find the API.
    new StringParameter(this, 'UrlParameter', {
      parameterName: '/lab/account/url',
      description: 'Base URL of the account API',
      stringValue: api.apiEndpoint,
    });

    // The pipeline reads Version after a deployment. Do not add an output that contains the account ID:
    // the deploy job prints the outputs to a public log. The core API ARN contains the account ID.
    new CfnOutput(this, 'Version', { value: props.version });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}
