# lab-svc-account

This repository holds the mock "account" service of the pipeline lab.
It is an AWS CDK app in TypeScript. The pipeline in [lab-workflows](https://github.com/jross24/lab-workflows) releases it.

The service has the same shape as [lab-svc-core](https://github.com/jross24/lab-svc-core).
This README explains what is different. The lab-svc-core README explains the stages and the release steps in more detail.

## What the service is

The service is one Lambda function behind an API Gateway HTTP API.
The API is public. It has one route, `GET /profile`, with no authoriser.

The function calls the private API of the core service. Then it returns JSON:

```json
{
  "service": "account",
  "version": "0.1.0",
  "core": { "version": "0.1.0", "itemCount": 3 },
  "profile": { "id": "user-1", "name": "First user", "plan": "free" }
}
```

The `version` field shows which release of this service runs.
The `core` block shows the version of core and the number of items that core returned.
So one request proves that the chain works: the public API, this function, the private API, the core function.

If the call to core fails, the route returns HTTP 502 with a JSON error. It does not hide the failure:

```json
{
  "service": "account",
  "version": "0.1.0",
  "error": "The call to the core service failed.",
  "cause": "core returned HTTP 403"
}
```

The response does not copy the error body of core, because that body can name an IAM role and an account.
The log of the function has the full error.

## How the service finds and calls core

The core stack writes two SSM parameters in each account where it runs.

| Parameter | How this service uses it |
| --- | --- |
| `/lab/core/url` | The stack gives it to the function as the environment variable `CORE_URL`. |
| `/lab/core/api-arn` | The stack allows the function role `execute-api:Invoke` on exactly this ARN. |

CloudFormation reads the two parameters at deployment. The CDK does not read them at synth.
So the templates name no account, and one `cdk synth` still serves each account.

The API of core uses IAM authorisation. So the function signs each request with AWS Signature Version 4.
It signs with the temporary credentials of its own role. The Lambda runtime puts them in environment variables.
The file `lib/sign.ts` does the signing with `@smithy/signature-v4` and `@aws-crypto/sha256-js`. esbuild bundles both into the function.

The stack also writes its own address for the web application of a later phase.

| Parameter | Value |
| --- | --- |
| `/lab/account/url` | The base URL of this API. Add `/profile` to call the route. |

## Deployment order: core first

Deploy core to an account before you deploy this service to that account.

CloudFormation reads `/lab/core/url` and `/lab/core/api-arn` when it deploys this stack.
If core is not in the account, the parameters do not exist, and the deployment fails before it creates a resource.
The pipeline deploys each service on its own, so it does not enforce this order. You must keep it.

CloudFormation reads the parameters again at each deployment of this stack.
If core gets a new URL, release or redeploy this service to pick it up.

## Stages

One `cdk synth` makes three CDK stages: `Test`, `Staging` and `Production`.
Each stage holds one stack, `lab-svc-account`. The file `lib/stages.ts` holds the settings that differ between stages.

| Setting | Test | Staging | Production |
| --- | --- | --- | --- |
| `logRetentionDays` | 7 | 7 | 30 |
| `gradualRelease` | false | false | true |

`gradualRelease` is a placeholder. No code uses it yet.

The code names no AWS account and no region. A stack goes to the account of the credentials that deploy it.
All three stages use the same bundled Lambda code.

## How a change reaches Production

1. Open a pull request. The `pr` workflow runs lint, typecheck, the tests and `cdk synth`.
2. Merge the pull request with a squash. The `release` workflow starts.
3. The workflow works out the next version from the commit title and creates the tag, for example `v0.2.0`.
4. The workflow builds one time and stores the zipped `cdk.out` in a GitHub release.
5. The workflow deploys that same zip to Test, then to Staging.
6. The workflow waits. A reviewer approves the `production` environment in GitHub. Then the workflow deploys the same zip to Production.

A title that starts with `feat:` gives a minor version. A title with `!` before the colon gives a major version. Any other title gives a patch version.

To go back to an old version, run the `redeploy` workflow. It deploys the stored zip of that release and does not build.

```
gh workflow run redeploy.yml -f version=0.1.0 -f environment=test
```

The three files in `.github/workflows/` are copies of the files in lab-svc-core. This repository has no other pipeline code.

## Run the checks locally

You need Node.js 22.18 or later. Node.js runs the TypeScript files directly, so there is no build step.
esbuild bundles the Lambda code during `cdk synth`. You do not need Docker.

```
npm ci
npm run lint
npm run typecheck
npm test
npm run synth
```

The tests and the synthesis do not need AWS credentials or a network.

## Deploy to a personal account

Do not deploy `Test`, `Staging` or `Production` from a laptop. Only the pipeline deploys them.

For your own experiments there is a fourth stage, `Dev`. The context value `dev=true` selects it.
With `dev=true` the app makes only the `Dev` stage, so the command cannot touch a pipeline stage by accident.

```
npx cdk deploy -c dev=true "Dev/*" --profile <your-dev-profile>
npx cdk destroy -c dev=true "Dev/*" --profile <your-dev-profile>
```

The deployment-order rule applies here too. Deploy the `Dev` stage of lab-svc-core to the account first.

## Layout

| Path | Content |
| --- | --- |
| `bin/app.ts` | The entry point that `cdk.json` names. |
| `lib/app.ts` | Reads the context values and makes the stages. |
| `lib/stages.ts` | The typed settings of each stage. |
| `lib/account-stage.ts` | The CDK stage. |
| `lib/account-stack.ts` | The stack: SSM lookups, function, IAM policy, API, SSM parameter, outputs. |
| `lib/profile-handler.ts` | The Lambda handler. |
| `lib/core-client.ts` | Calls `GET /items` of core and checks the answer. |
| `lib/sign.ts` | Signs a request with AWS Signature Version 4. |
| `test/` | The unit tests (vitest). |
| `.github/workflows/` | Three small files that call the workflows in lab-workflows. |
