import { describe, expect, it } from 'vitest';
import { signGet } from '../lib/sign.ts';

// Fake credentials. They are the example values from the AWS documentation and open nothing.
const FAKE_CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  sessionToken: 'fake-session-token',
};

const OPTIONS = {
  url: 'https://abc123.execute-api.eu-west-2.amazonaws.com/items',
  region: 'eu-west-2',
  credentials: FAKE_CREDENTIALS,
  now: new Date('2026-01-02T03:04:05Z'),
};

describe('signGet', () => {
  it('adds an authorization header with the execute-api service scope', async () => {
    const headers = await signGet(OPTIONS);
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260102\/eu-west-2\/execute-api\/aws4_request, /,
    );
    expect(headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it('signs the host header and adds the date and the session token', async () => {
    const headers = await signGet(OPTIONS);
    expect(headers.host).toBe('abc123.execute-api.eu-west-2.amazonaws.com');
    expect(headers.authorization).toContain('SignedHeaders=host;');
    expect(headers['x-amz-date']).toBe('20260102T030405Z');
    expect(headers['x-amz-security-token']).toBe('fake-session-token');
  });

  it('gives the same signature for the same input and a different one for a different path', async () => {
    const first = await signGet(OPTIONS);
    const second = await signGet(OPTIONS);
    const other = await signGet({ ...OPTIONS, url: 'https://abc123.execute-api.eu-west-2.amazonaws.com/other' });
    expect(second.authorization).toBe(first.authorization);
    expect(other.authorization).not.toBe(first.authorization);
  });
});
