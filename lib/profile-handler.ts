import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CoreError, fetchCoreSummary } from './core-client.ts';
import type { CoreSummary } from './core-client.ts';
import { instrument } from './instrument.ts';

type JsonResponse = APIGatewayProxyStructuredResultV2 & { readonly statusCode: number; readonly body: string };

const SERVICE = 'account';
const CORE_FAILED = 'The call to the core service failed.';

// Mock data. A later phase can replace it with a real data store.
const PROFILE = { id: 'user-1', name: 'First user', plan: 'free' } as const;

// The one place where the service fails on purpose. The stage config sets INJECT_FAULT for a stage.
// It is a device for the release drill, not a practice for production. See "The Production drill" in the README.
function failOnPurpose(): void {
  if (process.env.INJECT_FAULT === 'true') {
    throw new Error('injected fault: the stage config of this release sets injectFault');
  }
}

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
    // Outside the try block: a fault must reach Lambda, and it must not become a 502.
    failOnPurpose();
    let core: CoreSummary;
    try {
      core = await getCore();
    } catch (error) {
      // The log has the full error. The response has only a message that is safe on a public API.
      console.error(CORE_FAILED, error);
      const cause = error instanceof CoreError ? error.message : 'unexpected error';
      // The handler does not throw here, so Lambda does not count this call as an error.
      // The wrapper counts it: it counts each status of 500 or more as an error in the metric line.
      return json(502, { error: CORE_FAILED, cause });
    }
    // The core block proves that the answer passed through the core service.
    return json(200, { core, profile: PROFILE });
  };
}

export const handler = instrument({ service: SERVICE }, createHandler(() => fetchCoreSummary()));
