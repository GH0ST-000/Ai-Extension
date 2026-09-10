import { describe, expect, it } from 'vitest';

import { parseStackTrace } from './stack-trace.parser';

describe('parseStackTrace', () => {
  it('parses JS/Node frames', () => {
    const text = [
      'TypeError: Cannot read properties of undefined',
      '    at PaymentService.charge (/src/payment.service.ts:42:19)',
      '    at PaymentController.create (/src/payment.controller.ts:18:11)',
    ].join('\n');

    const frames = parseStackTrace(text);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({
      functionName: 'PaymentService.charge',
      file: '/src/payment.service.ts',
      line: 42,
      column: 19,
    });
    expect(frames[1]).toEqual({
      functionName: 'PaymentController.create',
      file: '/src/payment.controller.ts',
      line: 18,
      column: 11,
    });
  });

  it('does not throw on malformed stack traces', () => {
    expect(() => parseStackTrace('not a stack\nat ???')).not.toThrow();
    expect(parseStackTrace('garbage {{{')).toEqual([]);
  });
});
