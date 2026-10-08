import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CloudAssembly, CloudFormationStackArtifact } from 'aws-cdk-lib/cx-api';
import { createApp } from '../lib/app.ts';
import { DEV_STAGE, STAGES } from '../lib/stages.ts';

// The stages that inject a fault on purpose. Only the release drill changes it.
const DRILL_STAGES: readonly string[] = [];

// Twelve digits that are not a part of a longer number or of a hex hash.
const ACCOUNT_ID = /(?<![0-9a-f])[0-9]{12}(?![0-9a-f])/i;

interface TemplateShape {
  readonly Resources: Record<string, { readonly Type: string; readonly Properties?: { readonly Code?: unknown } }>;
  readonly Outputs: { readonly Version: { readonly Value: unknown } };
}

function templateOf(stack: CloudFormationStackArtifact): TemplateShape {
  return stack.template as TemplateShape;
}

function stageNames(assembly: CloudAssembly): string[] {
  // The cloud assembly lists the stages in alphabetical order.
  return assembly.nestedAssemblies.map((nested) => nested.displayName).sort();
}

function stackIds(assembly: CloudAssembly): string[] {
  return assembly.stacksRecursively.map((stack) => stack.hierarchicalId).sort();
}

function lambdaCode(assembly: CloudAssembly): unknown[] {
  return assembly.stacksRecursively.flatMap((stack) =>
    Object.values(templateOf(stack).Resources)
      .filter((resource) => resource.Type === 'AWS::Lambda::Function')
      .map((resource) => resource.Properties?.Code),
  );
}

function versions(assembly: CloudAssembly): unknown[] {
  return assembly.stacksRecursively.map((stack) => templateOf(stack).Outputs.Version.Value);
}

describe('the app with no context', () => {
  const assembly = createApp().synth();

  it('has the three stages Test, Staging and Production, and no other stage', () => {
    expect(stageNames(assembly)).toEqual(['Production', 'Staging', 'Test']);
  });

  it('has one stack in each stage', () => {
    expect(stackIds(assembly)).toEqual(['Production/Account', 'Staging/Account', 'Test/Account']);
  });

  it('has no account and no region in any stack', () => {
    for (const stack of assembly.stacksRecursively) {
      expect(stack.environment.name).toBe('aws://unknown-account/unknown-region');
    }
  });

  it('needs no lookup in an AWS account at synth', () => {
    // The stack reads the SSM parameters of core at deployment. A synth-time lookup shows as missing context.
    expect(assembly.manifest.missing ?? []).toEqual([]);
  });

  it('has no account ID in any template', () => {
    for (const stack of assembly.stacksRecursively) {
      expect(JSON.stringify(stack.template)).not.toMatch(ACCOUNT_ID);
    }
  });

  it('uses the same Lambda code asset in all three stages', () => {
    const code = lambdaCode(assembly);
    expect(code).toHaveLength(3);
    expect(code[0]).toBeDefined();
    expect(code[1]).toEqual(code[0]);
    expect(code[2]).toEqual(code[0]);
  });

  it('uses the version 0.0.0-dev', () => {
    expect(versions(assembly)).toEqual(['0.0.0-dev', '0.0.0-dev', '0.0.0-dev']);
  });
});

describe('the bundled Lambda code', () => {
  const assembly = createApp().synth();

  // The S3 key of the code is the hash of the asset, and the asset is the directory asset.<hash> in the cloud assembly.
  function bundleDirectory(): string {
    const [code] = lambdaCode(assembly) as { S3Key?: string }[];
    return join(assembly.directory, `asset.${(code?.S3Key ?? '').replace(/.zip$/, '')}`);
  }

  it('is one ES module, index.mjs, and not a CommonJS file', () => {
    const files = readdirSync(bundleDirectory());
    expect(files).toContain('index.mjs');
    expect(files).not.toContain('index.js');
  });

  it('is small, because esbuild removed the OpenTelemetry code that no request uses', () => {
    // As a CommonJS bundle the same code is 641 KB. The module entries of the packages let esbuild remove most of it.
    expect(statSync(join(bundleDirectory(), 'index.mjs')).size).toBeLessThan(200_000);
  });
});

describe('the app with a version in the context', () => {
  it('uses that version in each stage', () => {
    expect(versions(createApp({ version: '1.4.0' }).synth())).toEqual(['1.4.0', '1.4.0', '1.4.0']);
  });

  it.each(['', 'v1.4.0', '1.4', 'latest', '1.4.0 ', 140])('rejects the version %j', (version) => {
    expect(() => createApp({ version })).toThrow(/version must look like 1\.2\.3/);
  });
});

describe('the app with dev=true in the context', () => {
  const assembly = createApp({ dev: 'true' }).synth();

  it('has only the stage Dev', () => {
    expect(stageNames(assembly)).toEqual(['Dev']);
    expect(stackIds(assembly)).toEqual(['Dev/Account']);
  });

  it('has no account, no region and no account ID', () => {
    for (const stack of assembly.stacksRecursively) {
      expect(stack.environment.name).toBe('aws://unknown-account/unknown-region');
      expect(JSON.stringify(stack.template)).not.toMatch(ACCOUNT_ID);
    }
  });

  it('accepts dev=false and makes the three stages', () => {
    expect(stageNames(createApp({ dev: 'false' }).synth())).toEqual(['Production', 'Staging', 'Test']);
  });

  it('rejects a value of dev that is not true or false', () => {
    expect(() => createApp({ dev: 'yes' })).toThrow(/dev must be true or false/);
  });
});

describe('the stage config', () => {
  it('releases Test and Staging all at once, and Production as a canary of 10 percent for 5 minutes', () => {
    expect(STAGES.Test.release).toEqual({ kind: 'allAtOnce' });
    expect(STAGES.Staging.release).toEqual({ kind: 'allAtOnce' });
    expect(STAGES.Production.release).toEqual({ kind: 'canary', percent: 10, minutes: 5 });
    expect(DEV_STAGE.release).toEqual({ kind: 'allAtOnce' });
  });

  it('keeps the logs for 7 days in Test and Staging, and for 30 days in Production', () => {
    expect(STAGES.Test.logRetentionDays).toBe(7);
    expect(STAGES.Staging.logRetentionDays).toBe(7);
    expect(STAGES.Production.logRetentionDays).toBe(30);
  });

  it('injects a fault only in the stages that the list DRILL_STAGES names', () => {
    // The fault switch is a device for the release drill. A fault in the main branch is a mistake.
    // So a stage must be in the list and must set injectFault. One of the two alone fails this test.
    // The drill changes both in one pull request. See "The Production drill" in the README.
    for (const [name, config] of Object.entries(STAGES)) {
      expect(config.injectFault, name).toBe(DRILL_STAGES.includes(name));
    }
    expect(DEV_STAGE.injectFault).toBe(false);
  });
});

describe('the deployment configuration of each stage', () => {
  const assembly = createApp().synth();

  function groupOf(stage: string): { readonly Properties: { readonly DeploymentConfigName: string } } {
    const stack = assembly.stacksRecursively.find((candidate) => candidate.hierarchicalId === `${stage}/Account`);
    const groups = Object.values(stack ? templateOf(stack).Resources : {}).filter(
      (resource) => resource.Type === 'AWS::CodeDeploy::DeploymentGroup',
    );
    expect(groups).toHaveLength(1);
    return groups[0] as unknown as { readonly Properties: { readonly DeploymentConfigName: string } };
  }

  it('is all at once in Test and Staging, and a canary of 10 percent for 5 minutes in Production', () => {
    expect(groupOf('Test').Properties.DeploymentConfigName).toBe('CodeDeployDefault.LambdaAllAtOnce');
    expect(groupOf('Staging').Properties.DeploymentConfigName).toBe('CodeDeployDefault.LambdaAllAtOnce');
    expect(groupOf('Production').Properties.DeploymentConfigName).toBe('CodeDeployDefault.LambdaCanary10Percent5Minutes');
  });

  it('gives the function of each stage the sampling ratio of the stage config', () => {
    const configs: Record<string, { readonly traceSampleRatio: number }> = { ...STAGES };
    for (const [name, config] of Object.entries(configs)) {
      const stack = assembly.stacksRecursively.find((candidate) => candidate.hierarchicalId.startsWith(`${name}/`));
      const ratios = Object.values(templateOf(stack as CloudFormationStackArtifact).Resources)
        .map((resource) => (resource.Properties as { Environment?: { Variables?: Record<string, string> } } | undefined)?.Environment?.Variables?.TRACE_SAMPLE_RATIO)
        .filter((ratio) => ratio !== undefined);
      expect(ratios, name).toEqual([String(config.traceSampleRatio)]);
    }
  });

  it('is the only difference between the templates of the stages, apart from the stage config', () => {
    // Test must exercise the resources that Production runs. So the stages must differ only in the stage config:
    // the log retention, the deployment configuration, the sampling ratio, and the fault switch of the drill with the id of the
    // Lambda version that the switch changes.
    const normalised = (stage: string): string => {
      const stack = assembly.stacksRecursively.find((candidate) => candidate.hierarchicalId === `${stage}/Account`);
      return JSON.stringify(stack?.template)
        .replace(/"RetentionInDays":[0-9]+/g, '"RetentionInDays":0')
        .replace(/CodeDeployDefault\.Lambda[A-Za-z0-9]+/g, 'CodeDeployDefault.Lambda')
        .replace(/"INJECT_FAULT":"true",/g, '')
        .replace(/"TRACE_SAMPLE_RATIO":"[^"]*"/g, '"TRACE_SAMPLE_RATIO":"1"')
        .replace(/CurrentVersion[0-9A-F]{8}[0-9a-f]{32}/g, 'CurrentVersion');
    };
    expect(normalised('Staging')).toBe(normalised('Test'));
    expect(normalised('Production')).toBe(normalised('Test'));
  });
});
