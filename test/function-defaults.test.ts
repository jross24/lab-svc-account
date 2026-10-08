import { describe, expect, it } from 'vitest';
import { tracingEnvironment } from '../lib/function-defaults.ts';

describe('tracingEnvironment', () => {
  it('names the setting TRACE_SAMPLE_RATIO, which the handler reads', () => {
    expect(tracingEnvironment(0.25)).toEqual({ TRACE_SAMPLE_RATIO: '0.25' });
  });

  it.each([0, 1])('writes the ratio %d as a plain number', (ratio) => {
    expect(tracingEnvironment(ratio)).toEqual({ TRACE_SAMPLE_RATIO: String(ratio) });
  });

  it.each([-1, 1.5, Number.NaN])('stops the synth for the ratio %s', (ratio) => {
    expect(() => tracingEnvironment(ratio)).toThrow(/sampling ratio/);
  });
});
