import { readFileSync } from 'node:fs';

// The schema subset of contract.json and expectations.json, and three helpers for the tests of a service.
// The pipeline (lab-workflows, actions/contract) reads the same files. Its README explains the format and the rules.
//
// THIS FILE IS THE SAME IN EVERY SERVICE REPOSITORY THAT HAS A CONTRACT OR EXPECTATIONS (core, catalogue, account, web).
// Do not change one copy alone. The test contract-schema.test.ts has a copy in each repository too.

export interface Schema {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly items?: Schema;
  readonly description?: string;
}

export interface Endpoint {
  readonly request?: { readonly required?: readonly string[]; readonly optional?: readonly string[] };
  readonly responses: Readonly<Record<string, Schema>>;
}

export interface Contract {
  readonly service: string;
  readonly consumers?: readonly string[];
  readonly endpoints: Readonly<Record<string, Endpoint>>;
}

export interface Expectations {
  readonly service: string;
  readonly expects: Readonly<Record<string, Readonly<Record<string, { readonly sends?: readonly string[]; readonly responses: Readonly<Record<string, Schema>> }>>>>;
}

export function readJsonFile<T>(url: URL): T {
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

// The problems of a value against a schema, as readable lines. An empty list means that the value is valid.
// An object may have more properties than the schema lists. An integer is a valid number.
export function validate(schema: Schema, value: unknown, path = '$'): string[] {
  const problems: string[] = [];
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const matches =
    schema.type === 'integer' ? Number.isInteger(value) : schema.type === 'number' ? typeof value === 'number' : actual === schema.type;
  if (!matches) return [`${path}: expected ${schema.type}, got ${actual}`];

  if (schema.type === 'object') {
    const object = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (!(name in object)) problems.push(`${path}.${name}: required property is missing`);
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (name in object) problems.push(...validate(child, object[name], `${path}.${name}`));
    }
  } else if (schema.type === 'array' && schema.items) {
    (value as unknown[]).forEach((element, index) => problems.push(...validate(schema.items as Schema, element, `${path}[${index}]`)));
  }
  return problems;
}

// A value that has every property of the schema, with a simple value of the right type. An array has one element.
// A consumer test feeds it to the client of the consumer: the client must cope with exactly what the expectations list.
export function sample(schema: Schema): unknown {
  switch (schema.type) {
    case 'string':
      return 'text';
    case 'number':
      return 1.5;
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return schema.items ? [sample(schema.items)] : [];
    case 'object':
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, child]) => [name, sample(child)]));
  }
}

// The paths of all required properties, for example [['version'], ['items', '[]', 'name']].
// A consumer test removes each one in turn from the sample: the client must then fail, because the field is needed.
export function requiredPaths(schema: Schema, prefix: readonly string[] = []): string[][] {
  const paths: string[][] = [];
  if (schema.type === 'object') {
    for (const name of schema.required ?? []) paths.push([...prefix, name]);
    for (const [name, child] of Object.entries(schema.properties ?? {})) paths.push(...requiredPaths(child, [...prefix, name]));
  } else if (schema.type === 'array' && schema.items) {
    paths.push(...requiredPaths(schema.items, [...prefix, '[]']));
  }
  // A property that is required AND has required children appears once for each path. Sort them and remove copies.
  return [...new Map(paths.map((path) => [path.join('.'), path])).values()];
}

// A copy of the value without the property at the path. The element '[]' stands for the first element of an array.
export function withoutPath(value: unknown, path: readonly string[]): unknown {
  const copy = structuredClone(value);
  let node: unknown = copy;
  for (const step of path.slice(0, -1)) {
    node = step === '[]' ? (node as unknown[])[0] : (node as Record<string, unknown>)[step];
  }
  const last = path[path.length - 1] as string;
  if (last === '[]') (node as unknown[]).length = 0;
  else Reflect.deleteProperty(node as Record<string, unknown>, last);
  return copy;
}
