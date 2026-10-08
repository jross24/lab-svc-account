# lab-svc-account

This repository holds the mock "account" service of the pipeline lab.
It is an AWS CDK app in TypeScript. The pipeline in [lab-workflows](https://github.com/jross24/lab-workflows) releases it.

The service has the same shape as [lab-svc-core](https://github.com/jross24/lab-svc-core).
This README explains what is different. The lab-svc-core README explains the stages and the release steps in more detail.
It also explains the shared mechanics of the gradual release and of the observability. This README links to it and does not copy it.

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
The log of the function has the full error. The section "What an error means here" explains why this 502 matters for a release.

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
The call to core is also a client span of the trace. The section "Tracing" explains how the trace header and the signature work together.

The stack also writes its own address for the web application of a later phase. It writes its own version too.

| Parameter | Value |
| --- | --- |
| `/lab/account/url` | The base URL of this API. Add `/profile` to call the route. |
| `/lab/account/version` | The version of account that the stack runs. The release workflow of lab-workflows reads it, to check the deployment order and the set of tested versions. |

## Deployment order: core first

Deploy core to an account before you deploy this service to that account.

CloudFormation reads `/lab/core/url` and `/lab/core/api-arn` when it deploys this stack.
If core is not in the account, the parameters do not exist, and the deployment fails before it creates a resource.
The file `pipeline.json` names the services that this service needs: `"requires": { "core": ">=0.5.0" }`.
Before each deploy job changes an environment, the pipeline reads `/lab/core/version` in that environment. It stops the job with a clear message
if core is not there, or if its version is outside the range. The job fails before CloudFormation starts, so it changes nothing.
The README of [lab-workflows](https://github.com/jross24/lab-workflows) explains the check.

CloudFormation reads the parameters again at each deployment of this stack.
If core gets a new URL, release or redeploy this service to pick it up.

To ask "could this service go to that environment now?" without a release, start the dry run:
`gh workflow run check.yml --repo jross24/lab-svc-account -f environment=staging`. It reads SSM and deploys nothing.
The input `requires` replaces the requirements of `pipeline.json` for that run only, so you can see the failure message of a check.

## Stages

One `cdk synth` makes three CDK stages: `Test`, `Staging` and `Production`.
Each stage holds one stack, `lab-svc-account`. The file `lib/stages.ts` holds the settings that differ between stages.

| Setting | Test | Staging | Production |
| --- | --- | --- | --- |
| `logRetentionDays` | 7 | 7 | 30 |
| `release` | all at once | all at once | canary: 10 percent, then 100 percent after 5 minutes |
| `injectFault` | false | false | false |

Every stage has the same resources: the same alias, deployment group, alarms and dashboard. Only the values in the table differ.
A unit test compares the three templates. `injectFault` is a device for the release drill. No stage sets it in `main`.

The code names no AWS account and no region. A stack goes to the account of the credentials that deploy it.
All three stages use the same bundled Lambda code.

## Gradual release and observability

This service uses the pattern of [lab-svc-core](https://github.com/jross24/lab-svc-core). The core README has the shared mechanics:
"Gradual release" (the steps of a release, the rollback rules, how to watch a release) and "Observability" (log line, metrics, tracing, dashboard).

### What is the same as core

- The alias `live`. The API calls the alias, and CodeDeploy moves the traffic of the alias with the `release` setting of the stage.
- The alarms `ErrorsAlarm` and `LatencyAlarm` on the alias. The deployment group watches them and rolls back.
- One JSON log line and one embedded-metric line for each request, with the dimensions `service` and `version`.
- OpenTelemetry tracing, with no Lambda active tracing, and the fault switch `injectFault`. See "Tracing".
- Nine files in `lib/`. They are byte-identical copies of the files in core: `gradual-release.ts`, `service-dashboard.ts`, `instrument.ts`, `logger.ts`, `metrics.ts`, `tracing.ts`, `xray-exporter.ts`, `sigv4.ts` and `function-defaults.ts`.
- The tests `test/tracing.test.ts`, `test/xray-exporter.test.ts` and `test/sigv4.test.ts`. They are byte-identical copies too.
- The first release that contains this change creates the alias and goes to each stage without a canary.

### What is different from core

- **A third alarm.** `ServiceErrorsAlarm` watches the metric `errors` of `service=account` and of the version that the stack deploys. See "What an error means here".
- **The function calls core.** Its duration includes the signed call. The timeout is 10 seconds, and the latency threshold is 3000 ms. See "Where the latency threshold comes from".
  The trace has a client span for this call. See "Tracing".
- **The API is public.** The route has no authoriser. The alias runs with the role of the function, so the policy `execute-api:Invoke` on the core API did not change.
- **The dashboard** is named `lab-svc-account` and has one more graph: "Errors that the service counted, by version".
- **Nothing changed for a consumer.** The parameter `/lab/account/url`, the variable `CORE_URL` and the policy on the core ARN are the same.

The API integration calls the alias, and not the function. The invoke permission of the API moves to the alias in the same update.
The stack makes every integration of the API depend on every invoke permission of the API. The permission then exists before an integration calls the alias.
This route has one integration and one permission. The loop in `lib/account-stack.ts` also covers a stack with more routes.
Two unit tests prove it: "is the target of the invoke permission before the integration calls it" and "makes every integration of the API depend on every invoke permission of the API".

### What an error means here

Lambda counts a call as an error only when the function throws or times out. This service does not throw when the call to core fails.
It catches the failure and returns HTTP 502. So Lambda sees a good call, and `ErrorsAlarm` cannot see a new version that is unable to call core.
For example, a wrong `CORE_URL` or a missing permission gives a 502 on each call and no Lambda error.

The wrapper `instrument` counts each response with a status of 500 or more as an error in the metric line (`errors` is 1). It also logs the call at level `ERROR`.
`ServiceErrorsAlarm` fires on one such error or more in a period of 1 minute. It watches the version that the stack deploys.
During a canary it sees the errors of the new version, and not the errors of the old version. The deployment group watches it with the other two alarms.

The test "the exported handler when the core call fails" in `test/profile-handler.test.ts` proves this with the real handler and a fake core that fails.
It uses four failures: HTTP 503, HTTP 403, a failed request and an unreadable body. In each case the handler returns 502 and does not throw.
The metric line has `errors` set to 1, and the log level is `ERROR`. A second test compares the alarm with the metric line that the handler writes: same namespace, name, service and version.

A response with a status of 4xx is not an error. A failure of core also fires the alarm, and it rolls back a deployment of a good version.
When a deployment rolls back, check the dashboard `lab-svc-core` first.

### Where the latency threshold comes from

The latency alarm fires when the p99 duration of the alias is over `LATENCY_P99_THRESHOLD_MS` in 2 periods of 1 minute in a row.
The duration of this function includes the signed call to core. That call is about one more HTTPS round trip. A cold core adds its start time.
I measured the function in Test and in Production on 2026-10-07, with read-only calls. The windows end at about 22:10 UTC.
A warm call has no `Init Duration` in its `REPORT` line. A cold call has one.

I took these measurements before the change to OpenTelemetry, with 128 MB of memory and Lambda active tracing.
Now the function has 512 MB, and each call sends its spans before it returns. So the duration changes.
**After the tracing change (512 MB, OpenTelemetry).** The lab deployed the four services to its own account `lab-dev` on 2026-10-07 and loaded the web page.
The first request of account after a deployment (the whole chain cold) took 1.2 to 1.3 s. A warm request took 139 ms (median). Core took 0.45 to 0.47 s for its first request.
The value 3000 ms stays. It is above the first request, so a cold start does not fire the alarm. A core that hangs makes this function wait 5 s (the limit of its call to core), so a real fault fires it.
The core README has the full table for 128, 256, 512 and 1024 MB.


| Stage | Source and window | What | Result |
| --- | --- | --- | --- |
| Test | CloudWatch `Duration`, last 24 hours, 121 calls | p50, p99, max | 152 ms, 1993 ms, 2014 ms |
| Test | Logs Insights, 7 days, 106 warm calls | p50, p90, p99, max | 118 ms, 554 ms, 914 ms, 1035 ms |
| Test | Logs Insights, 7 days, 15 cold calls | init time, duration (average, max) | 183 ms (max 195 ms), 1830 ms (max 2014 ms) |
| Test | 26 public GET requests, 22:02 to 22:05 UTC, 3 s and 8 s apart | duration of the function | first call after a pause 554 ms. The other 25: p50 57 ms, max 147 ms |
| Production | CloudWatch `Duration`, last 24 hours, 20 calls | p50, p99, max | 180 ms, 2057 ms, 2059 ms |
| Production | Logs Insights, 7 days, 17 warm calls | p50, p90, p99, max | 164 ms, 471 ms, 1260 ms, 1260 ms |
| Production | Logs Insights, 7 days, 3 cold calls | init time, duration (average, max) | 172 ms (max 208 ms), 1888 ms (max 2059 ms) |

What the numbers show:

- A warm call in a steady stream takes under 150 ms.
- The slow warm calls that I checked (554 ms, 914 ms and 1260 ms) were each the first call after a pause of a few minutes.
- For the 914 ms call, the log of core shows two calls in the same second. Both took under 51 ms. So core did not cause the delay. I did not find the cause.
- A cold call takes 1.6 to 2.1 seconds. Most of this time is inside the handler. The init time is 150 to 210 ms and is not part of the duration.
- Production had only 20 calls in 24 hours, so its numbers are an estimate. Test has more calls and sets the value.

The threshold is **3000 ms**. It is about 3 times the warm p99 of Test (914 ms). It is above the slowest cold call that I saw (2059 ms), so a cold start alone does not fire the alarm.
It is below a third of the timeout (10 s divided by 3 is 3333 ms). A call to core that hangs stops at the client timeout of 5 seconds. That is over the threshold.
A unit test keeps the value between 2 times the measured warm p99 and a third of the timeout.

The log line now has the field `coldStart`. After the first release, measure again with Logs Insights. Compare the warm and the cold calls:

```
filter ispresent(status) and not ispresent(coldStart)
| stats count(), pct(durationMs, 50), pct(durationMs, 99), max(durationMs)
```

### The drill for this service

The full steps are in "The Production drill" of the [core README](https://github.com/jross24/lab-svc-core#the-production-drill). For this service:

1. Make one pull request with two edits. In `lib/stages.ts`, set `injectFault: true` in the `Production` block. In `test/app.test.ts`, set `DRILL_STAGES` to `['Production']`.
2. Give it the title `fix: drill, inject a fault in production`. Merge it, and wait at `deploy-production`.
3. Approve the `production` environment. Then start this traffic loop in a second terminal:

   ```
   ACC=$(aws ssm get-parameter --name /lab/account/url --profile lab-prod --query Parameter.Value --output text)
   for i in $(seq 1 180); do curl --silent --output /dev/null --write-out "%{http_code} " "$ACC/profile"; sleep 2; done
   ```

4. About one call in ten fails, because the canary gets 10 percent of the calls. The loop prints a 5xx status for them.
5. Expect `ErrorsAlarm` and `ServiceErrorsAlarm` to fire, CodeDeploy to roll back, and the job to fail. Then revert with `fix: remove the drill fault`.

The fault makes the function throw, so Lambda counts the error too. The 502 case, where the function does not throw, has a unit test and no drill of its own. The lab ran the same case for catalogue in `lab-dev`, with the same shared alarm code: see "What an error means here" in the README of lab-svc-catalogue. It did not run the case for account.

## Tracing

This service makes one OpenTelemetry trace for each request. The trace goes on across the services: web calls this service, and this service calls core.

Lambda active tracing is off. It would make a second trace for each call, and the two traces would not link.

The section [Tracing](https://github.com/jross24/lab-svc-core#tracing) of the lab-svc-core README explains the decision, the measurements and the trade-off. This README does not copy it.

### What the service records

- **One server span for each request.** The wrapper `instrument` makes it and names it after the route, `GET /profile`. If the request has a `traceparent` header, the span continues the trace of the caller.
- **One client span for each call to another service.** This service has one such call: the signed `GET /items` to core. The span is a child of the server span.

The log line of a request has the field `traceId`. It is the trace ID of the server span, in the X-Ray form `1-xxxxxxxx-yyyyyyyyyyyyyyyyyyyyyyyy`.

Each request ends with a flush: the function sends its spans before the handler returns. Lambda freezes the function after the return, and a frozen function cannot send.

A failed export never fails a request. The exporter writes one log line with the message `trace export failed`.

### How the trace crosses to core

The function signs the request to core first (`lib/sign.ts`). Then `lib/core-client.ts` sends it with `tracing.fetch`, which adds the header `traceparent`.

The signature lists only the `host` header and the `x-amz-` headers (`SignedHeaders`). So the new header does not break the signature.

The trace does not use the header `X-Amzn-Trace-Id`. API Gateway adds a part of its own to that header, and Lambda ignores it for its own trace. The core README shows the test.

The tests in `test/core-client.test.ts` prove this. Each test runs inside a server span with an in-memory exporter:

- The fake fetch receives the signed headers unchanged, plus `traceparent`. The test signs the request again and compares the headers.
- `SignedHeaders` does not list `traceparent` or `x-amzn-trace-id`.
- The client span is a child of the server span, and `traceparent` carries the ID of the client span.
- Outside a server span the headers do not change, and no span exists.
- When core answers HTTP 403, the client span has the status error. The function still throws a `CoreError` with the same safe message.

`test/profile-handler.test.ts` runs the real wrapper, the real handler and the real client. The trace ID is the same in the log line, in both spans and in the header that goes to core.

### How to find a trace

1. Take the value of `traceId` from a log line of the function.
2. Run this command with a read-only profile:

   ```
   aws xray batch-get-traces --trace-ids <traceId> --profile <read-only-profile>
   ```

When web calls this service, the log lines of web, of this service and of core show the same trace ID.

### What the stack sets for tracing

- **One more IAM statement.** The function role gets `xray:PutTraceSegments` on the resource `*`. X-Ray actions do not support a resource. It is the only X-Ray action of the role.
- **The OTLP endpoint of X-Ray.** The function sends its spans to `https://xray.<region>.amazonaws.com/v1/traces`. The request is signed with Signature Version 4 for the service `xray` (`lib/xray-exporter.ts`, `lib/sigv4.ts`).
- **Transaction Search.** The endpoint works only when CloudWatch Transaction Search is on in the account. The stack of core turns it on. This stack does not touch it.
- **512 MB of memory** (`FUNCTION_MEMORY_MB`). Lambda gives CPU in proportion to memory, and the export needs a TLS connection. The core README has the measurements.
- **An ES module bundle** (`FUNCTION_BUNDLING`). The handler file is `index.mjs`. esbuild reads the `module` entry of each package and removes the code that no request uses.
  A test in `test/app.test.ts` checks that the bundle is `index.mjs`, that there is no `index.js`, and that `index.mjs` is smaller than 200 KB.
- **No layer, and no active tracing.** A test checks that the template has no `TracingConfig` and no layer.

Outside Lambda the function has no name, so there is no tracing. The setting `TRACING=off` in the environment of the function switches it off in Lambda too.

### What is the same as core

These files are byte-identical copies of the files in core: `lib/tracing.ts`, `lib/xray-exporter.ts`, `lib/sigv4.ts`, `lib/function-defaults.ts` and `lib/instrument.ts`.
The tests `test/tracing.test.ts`, `test/xray-exporter.test.ts` and `test/sigv4.test.ts` are copies too.

`test/instrument.test.ts` is the test of core with three changes: the service name, the route key and the path.
The client span in `lib/core-client.ts` and the X-Ray statement in `lib/account-stack.ts` belong to this repository.

## How a change reaches Production

1. Open a pull request. The `pr` workflow runs lint, typecheck, the tests and `cdk synth`. It also scans the dependencies and the commits for secrets, and it checks the workflow files. It posts the `cdk diff` against Production as one comment. A delete or a replacement of a stateful resource fails the check until someone adds the label `destructive-change-approved`. The [README of lab-workflows](https://github.com/jross24/lab-workflows#the-cdk-diff-comment) explains the comment.
2. Merge the pull request with a squash. The `release` workflow starts.
3. The workflow works out the next version from the commit title and creates the tag, for example `v0.2.0`.
4. The workflow builds one time and stores the zipped `cdk.out` in a GitHub release.
5. The workflow takes the lock of Test. It checks the deployment order, deploys that same zip to Test, and runs the end-to-end suite. The suite also checks that Test reports the version of the release. The workflow records the four versions that passed as `tested-with.json` on the GitHub release.
6. The workflow checks the order and the tested set again in Staging, deploys the zip there, and runs the smoke subset of the suite. CodeDeploy moves the traffic at once in Test and in Staging.
7. The workflow waits. A reviewer approves the `production` environment in GitHub. A newer release that reaches this point cancels an older release that still waits. After the approval the workflow checks again, deploys the same zip to Production, and runs the smoke subset.
   CodeDeploy moves 10 percent of the traffic, waits 5 minutes, and moves the rest.
   If the smoke subset fails, the job fails and a redeploy of the earlier version waits for the reviewer.

The README of [lab-workflows](https://github.com/jross24/lab-workflows) explains each step.
To prove that a failed suite stops the release, set the repository variable `E2E_FAULT_DRILL` to `full-test`, `smoke-staging` or `smoke-production`. Remove it after the drill.

A title that starts with `feat:` gives a minor version. A title with `!` before the colon gives a major version. Any other title gives a patch version.

To go back to an old version, run the `redeploy` workflow. It deploys the stored zip of that release and does not build.

```
gh workflow run redeploy.yml -f version=<last-good-version> -f environment=test
```

A redeploy to Production is also a canary. Do not redeploy a release from before the gradual release (`0.1.0` and `0.1.1`).
Those releases have no alias. A redeploy of one removes the alias, the deployment group, the alarms and the dashboard.

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
The tests also read the bundle that `cdk synth` makes. They check that it is `index.mjs` and that it is small.

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
| `lib/stages.ts` | The typed settings of each stage: log retention, the release type and the fault switch. |
| `lib/account-stage.ts` | The CDK stage. |
| `lib/account-stack.ts` | The stack: SSM lookups, function (512 MB, ES module bundle), IAM policy for core and X-Ray, alias and release, API, dashboard, SSM parameters, outputs. |
| `lib/gradual-release.ts` | Copy from core. The alias, the deployment group, the three alarms and the `Release` type. |
| `lib/service-dashboard.ts` | Copy from core. The dashboard of a stage. |
| `lib/instrument.ts`, `lib/logger.ts`, `lib/metrics.ts` | Copy from core. The wrapper of the handler (it makes the server span), the log line and the metric line. |
| `lib/tracing.ts` | Copy from core. The class `Tracing`: server spans, client spans, the header `traceparent` and the flush. |
| `lib/xray-exporter.ts`, `lib/sigv4.ts` | Copy from core. Send the spans to the OTLP endpoint of X-Ray, signed with Signature Version 4. |
| `lib/function-defaults.ts` | Copy from core. The memory and the bundling options of the function. |
| `lib/profile-handler.ts` | The Lambda handler, wrapped by `instrument`, and the fault switch. |
| `lib/core-client.ts` | Calls `GET /items` of core as a client span and checks the answer. |
| `lib/sign.ts` | Signs the request to core with AWS Signature Version 4 for `execute-api`. It is not the same file as `lib/sigv4.ts`, which signs for `xray`. |
| `test/` | The unit tests (vitest). |
| `.github/workflows/` | Three small files that call the workflows in lab-workflows. |

## Release gate

Each release runs the end-to-end suite of [lab-e2e](https://github.com/jross24/lab-e2e) in Test before it goes to Staging.
