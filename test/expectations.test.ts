import { describe, expect, it, vi } from 'vitest';
import { CoreError, fetchCoreSummary } from '../lib/core-client.ts';
import type { CoreClientOptions } from '../lib/core-client.ts';
import { readJsonFile, requiredPaths, sample, validate, withoutPath } from './support/contract-schema.ts';
import type { Expectations, Schema } from './support/contract-schema.ts';

// What this service reads from other services is the file expectations.json. The pull request check of the pipeline
// verifies it against the contract of core that runs in Production. These tests keep the file true: the client of core
// copes with exactly what the file lists, and it needs each field that the file marks as required.

const expectations = readJsonFile<Expectations>(new URL('../expectations.json', import.meta.url));
const pipeline = readJsonFile<{ service: string; requires: Record<string, string> }>(new URL('../pipeline.json', import.meta.url));

const ALLOWED_KEYS = ['type', 'properties', 'required', 'items', 'description'];

// Fake values. The credentials are the example values from the AWS documentation and open nothing.
const ENV = {
  CORE_URL: 'https://abc123.execute-api.eu-west-2.amazonaws.com',
  AWS_REGION: 'eu-west-2',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_SESSION_TOKEN: 'fake-session-token',
};

const EXPECTED = expectations.expects.core?.['GET /items'];
const schema = EXPECTED?.responses['200'] as Schema;

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

function clientWith(body: unknown) {
  const fetch = vi.fn<NonNullable<CoreClientOptions['fetch']>>(async () => Response.json(body));
  return { fetch, env: ENV };
}

describe('expectations.json', () => {
  it('names this service, the same name as pipeline.json', () => {
    expect(expectations.service).toBe(pipeline.service);
  });

  it('expects only services that pipeline.json requires', () => {
    for (const provider of Object.keys(expectations.expects)) expect(Object.keys(pipeline.requires)).toContain(provider);
  });

  it('uses only the keywords that the pipeline understands', () => {
    expect(keywordProblems(schema, 'core GET /items 200')).toEqual([]);
  });

  it('lists the call that the client of core makes: GET /items with no input', async () => {
    expect(Object.keys(expectations.expects.core ?? {})).toEqual(['GET /items']);
    expect(EXPECTED?.sends).toEqual([]);
    const opts = clientWith(sample(schema));
    await fetchCoreSummary(opts);
    const [url, init] = opts.fetch.mock.calls[0] ?? [];
    expect(init?.method).toBe('GET');
    expect(new URL(String(url)).pathname).toBe('/items');
    expect(new URL(String(url)).search).toBe('');
  });
});

describe('the client of core and the expectations', () => {
  it('copes with an answer that has exactly the listed fields', async () => {
    const body = sample(schema) as { version: string; items: unknown[] };
    await expect(fetchCoreSummary(clientWith(body))).resolves.toEqual({ version: body.version, itemCount: body.items.length });
  });

  it('needs each field that the file marks as required (the test can fail)', async () => {
    const paths = requiredPaths(schema);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const broken = withoutPath(sample(schema), path);
      expect(validate(schema, broken), path.join('.')).not.toEqual([]);
      await expect(fetchCoreSummary(clientWith(broken)), path.join('.')).rejects.toBeInstanceOf(CoreError);
    }
  });

  it('reads no field of an item, so it copes with items that have neither name nor title', async () => {
    const summary = await fetchCoreSummary(clientWith({ service: 'core', version: '0.9.1', items: [{ id: 'item-1' }, {}] }));
    expect(summary).toEqual({ version: '0.9.1', itemCount: 2 });
  });

  it('gives the same result for the old items (name) and the new items (title)', async () => {
    const old = await fetchCoreSummary(clientWith({ version: '0.9.0', items: [{ id: 'item-1', name: 'First item' }] }));
    const next = await fetchCoreSummary(clientWith({ version: '0.9.0', items: [{ id: 'item-1', title: 'First item' }] }));
    expect(next).toEqual(old);
  });
});
