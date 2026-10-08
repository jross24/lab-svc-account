import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SERVICE = 'account';
const KNOWN_SERVICES = ['core', 'catalogue', 'account', 'web'];

interface Pipeline {
  readonly service: unknown;
  readonly requires: unknown;
}

function readPipeline(): Pipeline {
  return JSON.parse(readFileSync(new URL('../pipeline.json', import.meta.url), 'utf8')) as Pipeline;
}

describe('pipeline.json', () => {
  it('is valid JSON', () => {
    expect(() => readPipeline()).not.toThrow();
  });

  it(`names this service, ${SERVICE}`, () => {
    expect(readPipeline().service).toBe(SERVICE);
  });

  it('lists the required services as an object of version ranges', () => {
    const { requires } = readPipeline();
    expect(requires).toBeTypeOf('object');
    expect(requires).not.toBeNull();
    expect(Array.isArray(requires)).toBe(false);
    for (const range of Object.values(requires as Record<string, unknown>)) {
      expect(range).toBeTypeOf('string');
    }
  });

  it('requires only known services, and not this service', () => {
    const names = Object.keys(readPipeline().requires as Record<string, unknown>);
    for (const name of names) {
      expect(KNOWN_SERVICES).toContain(name);
      expect(name).not.toBe(SERVICE);
    }
  });
});
