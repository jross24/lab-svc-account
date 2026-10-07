import { App } from 'aws-cdk-lib';
import { AccountStage } from './account-stage.ts';
import { DEV_STAGE, STAGES } from './stages.ts';

const DEFAULT_VERSION = '0.0.0-dev';
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

function readVersion(app: App): string {
  const version: unknown = app.node.tryGetContext('version') ?? DEFAULT_VERSION;
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(
      `Context value version must look like 1.2.3. Got ${JSON.stringify(version)}. Example: -c version=1.2.3`,
    );
  }
  return version;
}

function readDev(app: App): boolean {
  // The value is a string from the command line and a boolean from cdk.json.
  const dev: unknown = app.node.tryGetContext('dev') ?? false;
  if (dev === true || dev === 'true') return true;
  if (dev === false || dev === 'false') return false;
  throw new Error(`Context value dev must be true or false. Got ${JSON.stringify(dev)}. Example: -c dev=true`);
}

// Context values: version (default 0.0.0-dev) and dev (default false).
export function createApp(context?: Record<string, unknown>): App {
  const app = new App({ context });
  const version = readVersion(app);

  if (readDev(app)) {
    // Only the Dev stage, so a laptop cannot deploy a pipeline stage by accident.
    new AccountStage(app, 'Dev', { version, config: DEV_STAGE });
    return app;
  }

  // One synth makes all three stages. The pipeline deploys each one from the same cdk.out.
  for (const [name, config] of Object.entries(STAGES)) {
    new AccountStage(app, name, { version, config });
  }
  return app;
}
