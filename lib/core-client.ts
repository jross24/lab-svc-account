import { signGet } from './sign.ts';

const ITEMS_PATH = '/items';
const TIMEOUT_MS = 5000;

export interface CoreSummary {
  readonly version: string;
  readonly itemCount: number;
}

// An error with a message that is safe to show to a caller of the public API.
export class CoreError extends Error {
  override readonly name = 'CoreError';
}

export interface CoreClientOptions {
  readonly fetch?: (
    url: string,
    init: { method: string; headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<Response>;
  readonly env?: Record<string, string | undefined>;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new CoreError(`the environment variable ${name} is not set`);
  return value;
}

function summaryOf(body: unknown): CoreSummary | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { version, items } = body as { version?: unknown; items?: unknown };
  if (typeof version !== 'string' || !Array.isArray(items)) return undefined;
  return { version, itemCount: items.length };
}

// Calls GET /items of the core service. The API of core accepts only a request that an IAM identity signed.
// The stack sets CORE_URL. The Lambda runtime sets the region and the credentials of the function role.
export async function fetchCoreSummary(options: CoreClientOptions = {}): Promise<CoreSummary> {
  const env = options.env ?? process.env;
  const send = options.fetch ?? fetch;

  const url = `${required(env, 'CORE_URL')}${ITEMS_PATH}`;
  const headers = await signGet({
    url,
    region: required(env, 'AWS_REGION'),
    credentials: {
      accessKeyId: required(env, 'AWS_ACCESS_KEY_ID'),
      secretAccessKey: required(env, 'AWS_SECRET_ACCESS_KEY'),
      sessionToken: env.AWS_SESSION_TOKEN,
    },
  });

  let response: Response;
  try {
    response = await send(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    throw new CoreError('the request to core failed', { cause });
  }
  // The body of an error from API Gateway can name the role and the account. Do not copy it into the message.
  if (response.status !== 200) throw new CoreError(`core returned HTTP ${response.status}`);

  const summary = summaryOf(await response.json().catch(() => undefined));
  if (!summary) throw new CoreError('core returned a body that this service does not understand');
  return summary;
}
