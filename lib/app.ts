import { App } from 'aws-cdk-lib';
import { AccountStage } from './account-stage.ts';
import { parseNamespace } from './namespace.ts';
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

function readNamespace(app: App, dev: boolean): string | undefined {
  const namespace: unknown = app.node.tryGetContext('namespace');
  if (namespace === undefined) return undefined;
  // A pipeline stage has fixed names. A namespace there would be an error that nobody sees, so refuse it.
  if (!dev) {
    throw new Error('Context value namespace works only with dev=true. Example: -c dev=true -c namespace=my-test');
  }
  return parseNamespace(namespace);
}

function readCoreNamespace(app: App, dev: boolean, namespace: string | undefined): string | undefined {
  const coreNamespace: unknown = app.node.tryGetContext('coreNamespace');
  if (coreNamespace === undefined) return undefined;
  // A pipeline stage reads the baseline parameters of core, in its own account. A preview of core exists only in Dev.
  if (!dev) {
    throw new Error(
      'Context value coreNamespace works only with dev=true. Example: -c dev=true -c namespace=my-test -c coreNamespace=pr-21',
    );
  }
  const valid = parseNamespace(coreNamespace, 'coreNamespace');
  // Without a namespace the copy is the baseline copy of the account. It must not point at a preview of core,
  // because the preview goes away when its pull request closes.
  if (namespace === undefined) {
    throw new Error(
      'Context value coreNamespace works only together with namespace. Example: -c dev=true -c namespace=my-test -c coreNamespace=pr-21',
    );
  }
  return valid;
}

// Context values: version (default 0.0.0-dev), dev (default false), namespace (default none, only with dev=true)
// and coreNamespace (default none, only with dev=true and a namespace). Without coreNamespace the service reads the
// baseline parameters of core.
export function createApp(context?: Record<string, unknown>): App {
  const app = new App({ context });
  const version = readVersion(app);
  const dev = readDev(app);
  const namespace = readNamespace(app, dev);
  const coreNamespace = readCoreNamespace(app, dev, namespace);

  if (dev) {
    // Only the Dev stage, so a laptop cannot deploy a pipeline stage by accident.
    new AccountStage(app, 'Dev', { version, config: DEV_STAGE, namespace, coreNamespace });
    return app;
  }

  // One synth makes all three stages. The pipeline deploys each one from the same cdk.out.
  for (const [name, config] of Object.entries(STAGES)) {
    new AccountStage(app, name, { version, config });
  }
  return app;
}
