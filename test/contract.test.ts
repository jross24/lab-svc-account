import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountStack } from '../lib/account-stack.ts';
import { createHandler } from '../lib/profile-handler.ts';
import { readJsonFile, validate } from './support/contract-schema.ts';
import type { Contract, Schema } from './support/contract-schema.ts';

// The contract of this service is the file contract.json. The web application reads it (as a release asset), and the
// pull request check of the pipeline compares it with the contract that runs in Production. These tests keep the file true:
// the real handler answers as the file says, and the file lists the routes that the stack has.

const contract = readJsonFile<Contract>(new URL('../contract.json', import.meta.url));
const pipeline = readJsonFile<{ service: string }>(new URL('../pipeline.json', import.meta.url));

const ALLOWED_KEYS = ['type', 'properties', 'required', 'items', 'description'];

afterEach(() => {
  vi.unstubAllEnvs();
});

// The pipeline refuses any other keyword, so nobody thinks that it is checked.
function keywordProblems(schema: Schema, path: string): string[] {
  const problems = Object.keys(schema)
    .filter((key) => !ALLOWED_KEYS.includes(key))
    .map((key) => `${path}: unsupported keyword ${key}`);
  for (const [name, child] of Object.entries(schema.properties ?? {})) problems.push(...keywordProblems(child, `${path}.${name}`));
  if (schema.items) problems.push(...keywordProblems(schema.items, `${path}[]`));
  for (const name of schema.required ?? []) {
    if (!(name in (schema.properties ?? {}))) problems.push(`${path}: required name ${name} is not in properties`);
  }
  return problems;
}

async function answer(): Promise<{ readonly statusCode: number; readonly body: unknown }> {
  vi.stubEnv('VERSION', '1.2.3');
  const response = await createHandler(async () => ({ version: '0.9.1', itemCount: 3 }))();
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

describe('contract.json', () => {
  it('names this service, the same name as pipeline.json', () => {
    expect(contract.service).toBe(pipeline.service);
  });

  it('lists the consumers that call this service', () => {
    expect(contract.consumers).toEqual(['web']);
  });

  it('uses only the keywords that the pipeline understands', () => {
    for (const [endpoint, description] of Object.entries(contract.endpoints)) {
      for (const [status, schema] of Object.entries(description.responses)) {
        expect(keywordProblems(schema, `${endpoint} ${status}`)).toEqual([]);
      }
    }
  });

  it('lists exactly the routes that the stack has', { timeout: 30_000 }, () => {
    const stack = new AccountStack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Account', {
      version: '1.2.3',
      config: { logRetentionDays: RetentionDays.ONE_WEEK, release: { kind: 'allAtOnce' }, injectFault: false, traceSampleRatio: 1 },
    });
    const routes = Object.values(Template.fromStack(stack).findResources('AWS::ApiGatewayV2::Route')).map(
      (route) => (route as { Properties: { RouteKey: string } }).Properties.RouteKey,
    );
    expect(Object.keys(contract.endpoints).sort()).toEqual(routes.sort());
  });

  it('lists no input for GET /profile, because the route reads none', () => {
    expect(contract.endpoints['GET /profile']?.request).toEqual({ required: [], optional: [] });
  });
});

describe('the answer of GET /profile', () => {
  const schema = contract.endpoints['GET /profile']?.responses['200'] as Schema;

  it('has the shape of the contract', async () => {
    const { statusCode, body } = await answer();
    expect(statusCode).toBe(200);
    expect(validate(schema, body)).toEqual([]);
  });

  it('would not pass the check if the handler dropped a field of the contract (the test can fail)', () => {
    expect(
      validate(schema, { service: 'account', version: '1.2.3', core: { version: '0.9.1' }, profile: { id: 'user-1', name: 'First user', plan: 'free' } }),
    ).toEqual(['$.core.itemCount: required property is missing']);
  });
});
