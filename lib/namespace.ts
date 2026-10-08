// The context value `namespace` lets several copies of this service live in one account.
// The Dev stage reads it. The pipeline stages never do. See "Namespaces" in the README.

// The tag that marks every resource of a namespaced copy. It helps to find the resources and the cost of a copy.
export const NAMESPACE_TAG = 'lab-namespace';

// A letter first, then letters a-z, digits and hyphens. At most 20 characters. The code also refuses a hyphen at the end.
// The limit keeps the longest stack name (lab-svc-account-<namespace>) far below the limit of CloudFormation.
const NAMESPACE = /^[a-z][a-z0-9-]{0,19}$/;

// The key is the name of the context value. It only shapes the message. The rule is the same for every key.
export function parseNamespace(value: unknown, key = 'namespace'): string {
  if (typeof value !== 'string' || !NAMESPACE.test(value) || value.endsWith('-')) {
    throw new Error(
      `Context value ${key} must be 1 to 20 characters: a letter a-z first, then letters a-z, digits and -, and no - at the end. Got ${JSON.stringify(value)}. Example: -c ${key}=${key === 'namespace' ? 'my-test' : 'pr-21'}`,
    );
  }
  return value;
}

// The names that must be unique in an account. Everything else in the stack gets its name from CloudFormation,
// and that name holds the stack name, so it is unique too.
export interface ServiceNames {
  readonly stackName: string;
  // The SSM parameter that holds the base URL of the API. The web application reads it.
  readonly urlParameterName: string;
  // The SSM parameter that holds the version that the stack runs. The release workflow reads the one of the baseline copy.
  readonly versionParameterName: string;
  readonly dashboardName: string;
}

// With no namespace the names are the names of the baseline copy of the account. They never change.
export function namesFor(namespace?: string): ServiceNames {
  if (namespace === undefined) {
    return {
      stackName: 'lab-svc-account',
      urlParameterName: '/lab/account/url',
      versionParameterName: '/lab/account/version',
      dashboardName: 'lab-svc-account',
    };
  }
  const valid = parseNamespace(namespace);
  return {
    stackName: `lab-svc-account-${valid}`,
    urlParameterName: `/lab/ns/${valid}/account/url`,
    versionParameterName: `/lab/ns/${valid}/account/version`,
    dashboardName: `lab-svc-account-${valid}`,
  };
}

// The two parameters that this service reads from its provider, core. Core writes them in each account.
export interface CoreNames {
  readonly urlParameterName: string;
  // The resource ARN for execute-api:Invoke on GET /items. The policy of the function uses it.
  readonly apiArnParameterName: string;
}

// With no namespace of core the service reads the baseline copy of core. This is the default for every copy of account,
// with or without a namespace of its own. The context value `coreNamespace` points the service at a preview of core.
export function coreNamesFor(coreNamespace?: string): CoreNames {
  if (coreNamespace === undefined) {
    return { urlParameterName: '/lab/core/url', apiArnParameterName: '/lab/core/api-arn' };
  }
  const valid = parseNamespace(coreNamespace, 'coreNamespace');
  return {
    urlParameterName: `/lab/ns/${valid}/core/url`,
    apiArnParameterName: `/lab/ns/${valid}/core/api-arn`,
  };
}
