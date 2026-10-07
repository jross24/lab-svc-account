import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';

export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  // Temporary credentials, such as those of a Lambda role, also have a session token.
  readonly sessionToken?: string;
}

export interface SignGetOptions {
  readonly url: string;
  readonly region: string;
  readonly credentials: Credentials;
  // The time of the signature. The default is the current time.
  readonly now?: Date;
}

// Signs a GET request to an API Gateway API with AWS Signature Version 4.
// It returns the headers that the request must have. API Gateway rejects a request without them.
export async function signGet(options: SignGetOptions): Promise<Record<string, string>> {
  const url = new URL(options.url);
  const signer = new SignatureV4({
    // API Gateway checks the signature against this service name.
    service: 'execute-api',
    region: options.region,
    credentials: options.credentials,
    sha256: Sha256,
  });
  const signed = await signer.sign(
    {
      method: 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      // The signature must cover the host header.
      headers: { host: url.host },
    },
    { signingDate: options.now },
  );
  return signed.headers;
}
