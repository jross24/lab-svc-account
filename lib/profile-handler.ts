import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CoreError, fetchCoreSummary } from './core-client.ts';
import type { CoreSummary } from './core-client.ts';

type JsonResponse = APIGatewayProxyStructuredResultV2 & { readonly body: string };

const SERVICE = 'account';
const CORE_FAILED = 'The call to the core service failed.';

// Mock data. A later phase can replace it with a real data store.
const PROFILE = { id: 'user-1', name: 'First user', plan: 'free' } as const;

function json(statusCode: number, body: Record<string, unknown>): JsonResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    // The stack sets VERSION at synth time, so the response shows which release runs.
    body: JSON.stringify({ service: SERVICE, version: process.env.VERSION ?? 'unknown', ...body }),
  };
}

// A test gives its own getCore, so it needs no network and no AWS credentials.
export function createHandler(getCore: () => Promise<CoreSummary>): () => Promise<JsonResponse> {
  return async () => {
    let core: CoreSummary;
    try {
      core = await getCore();
    } catch (error) {
      // The log has the full error. The response has only a message that is safe on a public API.
      console.error(CORE_FAILED, error);
      const cause = error instanceof CoreError ? error.message : 'unexpected error';
      return json(502, { error: CORE_FAILED, cause });
    }
    // The core block proves that the answer passed through the core service.
    return json(200, { core, profile: PROFILE });
  };
}

export const handler = createHandler(() => fetchCoreSummary());
