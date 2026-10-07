import { describe, expect, it } from 'vitest';
import { signRequest } from '../lib/sigv4.ts';

// The example key from the AWS documentation. It is not a real key.
const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const NOW = new Date('2015-08-30T12:36:00Z');
const NO_TIME = { url: 'https://example.amazonaws.com/', region: 'us-east-1', service: 'service', credentials: CREDENTIALS };
const BASE = { ...NO_TIME, now: NOW };

function signatureOf(headers: Record<string, string>): string {
  return /Signature=([0-9a-f]{64})$/.exec(headers.authorization ?? '')?.[1] ?? '';
}

describe('signRequest', () => {
  // The two vectors come from the AWS Signature Version 4 test suite (get-vanilla and post-vanilla).
  it('gives the signature of the AWS test vector get-vanilla', () => {
    const headers = signRequest({ ...BASE, method: 'GET' });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });

  it('gives the signature of the AWS test vector post-vanilla', () => {
    expect(signatureOf(signRequest({ ...BASE, method: 'POST' }))).toBe(
      '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
    );
  });

  it('does not return the host header, because fetch sets it from the URL', () => {
    expect(signRequest({ ...BASE, method: 'GET' })).not.toHaveProperty('host');
  });

  it('signs the body: another body gives another signature', () => {
    const one = signRequest({ ...BASE, method: 'POST', body: '{"a":1}' });
    const two = signRequest({ ...BASE, method: 'POST', body: '{"a":2}' });
    expect(signatureOf(one)).not.toBe(signatureOf(two));
    expect(signatureOf(one)).not.toBe(signatureOf(signRequest({ ...BASE, method: 'POST' })));
  });

  it('signs the headers that the caller gives, in sorted order, with lower case names', () => {
    const headers = signRequest({ ...BASE, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(headers.authorization).toContain('SignedHeaders=content-type;host;x-amz-date,');
    expect(headers['content-type']).toBe('application/json');
  });

  it('adds and signs the session token of temporary credentials', () => {
    const headers = signRequest({
      ...BASE,
      method: 'GET',
      credentials: { ...CREDENTIALS, sessionToken: 'token-value' },
    });
    expect(headers['x-amz-security-token']).toBe('token-value');
    expect(headers.authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token,');
  });

  it('puts the sorted query string into the signature', () => {
    const sorted = signRequest({ ...BASE, url: 'https://example.amazonaws.com/?b=2&a=1', method: 'GET' });
    const same = signRequest({ ...BASE, url: 'https://example.amazonaws.com/?a=1&b=2', method: 'GET' });
    expect(signatureOf(sorted)).toBe(signatureOf(same));
    expect(signatureOf(sorted)).not.toBe(signatureOf(signRequest({ ...BASE, method: 'GET' })));
  });

  it('uses the current time when the caller gives none', () => {
    expect(signRequest({ ...NO_TIME, method: 'GET' })['x-amz-date']).toMatch(/^[0-9]{8}T[0-9]{6}Z$/);
  });
});
