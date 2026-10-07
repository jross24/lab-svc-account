import { createHash, createHmac } from 'node:crypto';

// AWS Signature Version 4 for a request with a short body. The trace exporter uses it to send spans to the
// OTLP endpoint of X-Ray. The function is small on purpose: it needs no AWS SDK package.
// The unit tests check it against two vectors of the AWS test suite.

export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  // Temporary credentials, such as those of a Lambda role, also have a session token.
  readonly sessionToken?: string | undefined;
}

export interface SignOptions {
  readonly method: string;
  readonly url: string;
  // Extra headers that the signature must cover, for example content-type.
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: Credentials;
  // The time of the signature. The default is the current time.
  readonly now?: Date;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, text: string): Buffer {
  return createHmac('sha256', key).update(text, 'utf8').digest();
}

function encode(text: string): string {
  // RFC 3986: the characters ! ' ( ) * need an escape too.
  return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([a, aValue], [b, bValue]) => (a === b ? (aValue < bValue ? -1 : 1) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

// Returns the headers that the request must carry. The host header is not in the result: fetch sets it from the URL.
export function signRequest(options: SignOptions): Record<string, string> {
  const url = new URL(options.url);
  const amzDate = (options.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const body = options.body ?? '';

  const toSign: Record<string, string> = { host: url.host, 'x-amz-date': amzDate };
  for (const [name, value] of Object.entries(options.headers ?? {})) toSign[name.toLowerCase()] = value.trim();
  if (options.credentials.sessionToken) toSign['x-amz-security-token'] = options.credentials.sessionToken;

  const names = Object.keys(toSign).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((name) => `${name}:${toSign[name]}\n`).join('');
  // The path of a normal request is already encoded. API Gateway and X-Ray do not need a second encoding.
  const canonicalRequest = [
    options.method.toUpperCase(),
    url.pathname,
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join('\n');

  const scope = `${date}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${options.credentials.secretAccessKey}`, date), options.region), options.service),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  const headers = Object.fromEntries(Object.entries(toSign).filter(([name]) => name !== 'host'));
  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
