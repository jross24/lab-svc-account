import { describe, expect, it } from 'vitest';
import { requiredPaths, sample, validate, withoutPath } from './support/contract-schema.ts';
import type { Schema } from './support/contract-schema.ts';

// This test is the same in every service repository that has a contract or expectations.

const SCHEMA: Schema = {
  type: 'object',
  required: ['version', 'items'],
  properties: {
    version: { type: 'string' },
    count: { type: 'integer' },
    ratio: { type: 'number' },
    flag: { type: 'boolean' },
    items: {
      type: 'array',
      items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' } } },
    },
  },
};

describe('validate', () => {
  it('accepts a value that has the required properties with the right types', () => {
    expect(validate(SCHEMA, { version: '1.0.0', items: [{ id: 'a' }] })).toEqual([]);
  });

  it('accepts more properties than the schema lists', () => {
    expect(validate(SCHEMA, { version: '1.0.0', items: [], extra: 1 })).toEqual([]);
  });

  it('reports a missing required property with its path', () => {
    expect(validate(SCHEMA, { items: [] })).toEqual(['$.version: required property is missing']);
    expect(validate(SCHEMA, { version: 'x', items: [{ name: 'n' }] })).toEqual(['$.items[0].id: required property is missing']);
  });

  it('reports a wrong type with the path, the expected type and the real type', () => {
    expect(validate(SCHEMA, { version: 1, items: [] })).toEqual(['$.version: expected string, got number']);
    expect(validate(SCHEMA, { version: 'x', items: {} })).toEqual(['$.items: expected array, got object']);
    expect(validate(SCHEMA, { version: 'x', items: [null] })).toEqual(['$.items[0]: expected object, got null']);
  });

  it('treats an integer as a number, and a fraction as no integer', () => {
    expect(validate(SCHEMA, { version: 'x', items: [], ratio: 3 })).toEqual([]);
    expect(validate(SCHEMA, { version: 'x', items: [], count: 1.5 })).toEqual(['$.count: expected integer, got number']);
  });

  it('checks an optional property when it is present', () => {
    expect(validate(SCHEMA, { version: 'x', items: [], flag: 'yes' })).toEqual(['$.flag: expected boolean, got string']);
  });
});

describe('sample', () => {
  it('makes a value that is valid against the schema and has every property', () => {
    const value = sample(SCHEMA) as Record<string, unknown>;
    expect(validate(SCHEMA, value)).toEqual([]);
    expect(Object.keys(value).sort()).toEqual(['count', 'flag', 'items', 'ratio', 'version']);
    expect((value.items as unknown[]).length).toBe(1);
  });
});

describe('requiredPaths and withoutPath', () => {
  it('lists the required properties, also inside arrays', () => {
    expect(requiredPaths(SCHEMA)).toEqual([['version'], ['items'], ['items', '[]', 'id']]);
  });

  it('removes one property at a time and leaves the rest', () => {
    const value = sample(SCHEMA);
    expect(validate(SCHEMA, withoutPath(value, ['version']))).toEqual(['$.version: required property is missing']);
    expect(validate(SCHEMA, withoutPath(value, ['items', '[]', 'id']))).toEqual(['$.items[0].id: required property is missing']);
    // The original value stays whole.
    expect(validate(SCHEMA, value)).toEqual([]);
  });
});
