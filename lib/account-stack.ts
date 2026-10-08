import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CfnIntegration, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { CfnPermission, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { FUNCTION_BUNDLING, FUNCTION_MEMORY_MB } from './function-defaults.ts';
import { GradualRelease } from './gradual-release.ts';
import { ServiceDashboard } from './service-dashboard.ts';
import type { StageConfig } from './stages.ts';

const PROFILE_PATH = '/profile';

// The name of this service in the log line and in the metric line. The handler uses the same name.
// A test compares the metric that the handler writes with the alarm that this stack makes.
const SERVICE = 'account';

// The function waits for core, and core can have a cold start.
// The latency alarm compares the p99 duration with a threshold far below this limit.
export const FUNCTION_TIMEOUT = Duration.seconds(10);

// The p99 duration of the alias. The duration includes the signed call to core: about one more HTTPS round trip.
// The README shows the measurement. In Test, a warm call had a p99 of 914 ms, and a cold call took up to 2.06 s.
// This value is about 3 times the warm p99. It is above the slowest cold call, and below a third of the timeout.
export const LATENCY_P99_THRESHOLD_MS = 3000;

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
      timeout: FUNCTION_TIMEOUT,
      memorySize: FUNCTION_MEMORY_MB,
      bundling: FUNCTION_BUNDLING,
      // No active tracing of Lambda: OpenTelemetry makes the traces (lib/tracing.ts). The README of lab-svc-core explains why.
      environment: {
        // The version of the release is a part of the function, so each release publishes a new Lambda version.
        VERSION: props.version,
        CORE_URL: coreUrl,
        ...(props.config.injectFault ? { INJECT_FAULT: 'true' } : {}),
      },
      logGroup: new LogGroup(this, 'ProfileFunctionLogs', {
        retention: props.config.logRetentionDays,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    // The API of core uses IAM authorisation. This is the only permission that the function needs for it.
    // The alias live runs with the role of the function, so the alias has this permission too.
    profileFunction.addToRolePolicy(
      new PolicyStatement({ actions: ['execute-api:Invoke'], resources: [coreApiArn] }),
    );

    // The function sends its spans to the OTLP endpoint of X-Ray. The endpoint checks this permission.
    // X-Ray actions do not support a resource, so the resource is *.
    // The endpoint works only with Transaction Search, which the core stack turns on for the account.
    profileFunction.addToRolePolicy(new PolicyStatement({ actions: ['xray:PutTraceSegments'], resources: ['*'] }));

    // The alias `live` is what the API calls. CodeDeploy moves the traffic of the alias to each new version.
    // The alarm ServiceErrorsAlarm is here because this service answers a failure of core with HTTP 502 and does not throw.
    // Lambda does not count such a call as an error. The README explains this.
    const release = new GradualRelease(this, 'Release', {
      function: profileFunction,
      release: props.config.release,
      latencyP99ThresholdMs: LATENCY_P99_THRESHOLD_MS,
      serviceErrors: { service: SERVICE, version: props.version },
    });
    // The lab has no notification target. To page an on-call, make an SNS topic here and add it to the three alarms:
    //   release.errorsAlarm.addAlarmAction(new SnsAction(topic));
    //   release.latencyAlarm.addAlarmAction(new SnsAction(topic));
    //   release.serviceErrorsAlarm?.addAlarmAction(new SnsAction(topic));
    // The same alarms then page the on-call and stop a bad deployment. No other code changes.

    const api = new HttpApi(this, 'Api', { description: 'lab-svc-account: mock public API' });

    // No authoriser: the route is public.
    // The integration calls the alias, not the function. The route and the API stay the same, so the web
    // application needs no change: it reads the URL of the API from SSM.
    api.addRoutes({
      path: PROFILE_PATH,
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('ProfileIntegration', release.alias),
    });

    // The first release with an alias updates a running API. The integration moves from the function to the alias,
    // and the invoke permission moves too. Each permission must exist before an integration calls the alias.
    // Without this, CloudFormation may update an integration first, and the API fails for a few seconds.
    // The loops cover all permissions and all integrations. A stack with more routes has more of both.
    const permissions = api.node.findAll().filter((node): node is CfnPermission => node instanceof CfnPermission);
    const integrations = api.node.findAll().filter((node): node is CfnIntegration => node instanceof CfnIntegration);
    if (permissions.length === 0 || integrations.length === 0) {
      throw new Error('The API has no integration or no invoke permission.');
    }
    for (const integration of integrations) {
      for (const permission of permissions) {
        integration.addResourceDependency(permission, 'The alias needs the invoke permission before the API calls it.');
      }
    }

    new ServiceDashboard(this, 'Dashboard', { service: SERVICE, release, api });

    // The web application reads this parameter to find the API.
    new StringParameter(this, 'UrlParameter', {
      parameterName: '/lab/account/url',
      description: 'Base URL of the account API',
      stringValue: api.apiEndpoint,
    });

    // The pipeline of the other services reads this parameter. It checks the deployment order and the set of tested versions.
    const versionParameter = new StringParameter(this, 'VersionParameter', {
      parameterName: '/lab/account/version',
      description: 'Version of account that this stack runs',
      stringValue: props.version,
    });
    // CloudFormation updates the alias, then waits for the CodeDeploy deployment (canary in Production), and only then
    // updates this parameter. So the parameter shows the new version when the release is complete.
    // A rollback of the traffic leaves the old version in the parameter.
    versionParameter.node.addDependency(release.alias);

    // The pipeline reads Version after a deployment. Do not add an output that contains the account ID:
    // the deploy job prints the outputs to a public log. The core API ARN contains the account ID.
    new CfnOutput(this, 'Version', { value: props.version });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}
