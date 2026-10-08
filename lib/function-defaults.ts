import { OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SAMPLE_RATIO_ENV, parseSampleRatio } from './tracing.ts';

// Settings that all four services give to their function. The README of lab-svc-core explains the numbers.

// Lambda gives CPU in proportion to memory. At 128 MB the function has about 7 percent of one vCPU, and the first
// request spent 1.9 s on the TLS connection to the trace endpoint. At 512 MB the same request took 0.45 s.
export const FUNCTION_MEMORY_MB = 512;

// An ES module with the "module" entry of each package. esbuild then removes the code that no request uses.
// The OpenTelemetry packages shrink from 641 KB to 111 KB this way, and the cold start gets shorter.
// The banner gives a bundled package the function "require", which an ES module does not have.
export const FUNCTION_BUNDLING: BundlingOptions = {
  format: OutputFormat.ESM,
  mainFields: ['module', 'main'],
  banner: "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
};

// The setting of a stage for the sampling ratio, as the environment of the function. The handler reads it in
// tracing.ts. The check is here too, so a ratio outside 0 to 1 stops the synth and never reaches a function.
export function tracingEnvironment(sampleRatio: number): Record<string, string> {
  return { [SAMPLE_RATIO_ENV]: String(parseSampleRatio(sampleRatio)) };
}
