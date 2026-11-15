/**
 * Verifier prompt contract (observed live failures: empty triggers, restated evidence, wrong
 * authorization refutations, failure sites before the sink). The deterministic gates stay the
 * authority; the prompt asks for exactly what they check, within the existing token budget.
 */
import { zodSchema } from 'ai';
import { describe, expect, it } from 'vitest';

import {
  PR_REVIEW_VERIFY_INSTRUCTIONS,
  VERIFY_REQUEST_OVERHEAD_CHARS,
  verificationSchema,
} from './pr-review-verify';

describe('verifier instructions', () => {
  const text = PR_REVIEW_VERIFY_INSTRUCTIONS;

  it('asks for trigger, path, sink, independent evidence and every guard, in that order', () => {
    const order = ['(1) TRIGGER', '(2) PATH', '(3) SINK', '(4) EVIDENCE', '(5) GUARDS'].map((k) =>
      text.indexOf(k),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toMatch(/never a check, log or line that runs before it/);
    expect(text).toMatch(/repeating the suspicious line alone proves nothing/);
  });

  it('spells out what is and is not a refutation, and how helpers are judged', () => {
    expect(text).toMatch(/helper whose return value is ignored protects nothing/);
    expect(text).toMatch(/never by its name/);
    expect(text).toMatch(
      /vulnerable operation itself, an unrelated check, or a helper name is never a refutation/,
    );
    expect(text).toMatch(/bound to the requesting user and this resource/);
  });

  it('keeps missing evidence explicit and forbids inventing code', () => {
    expect(text).toMatch(/never invent code/);
    expect(text).toMatch(
      /insufficient_context: the trigger, the sink, or a deciding check or helper is not in the provided code/,
    );
    expect(text).toMatch(
      /dependsOnCodeNotShown=true only when a specific function or value that is not shown decides the outcome/,
    );
  });

  it('stays within the existing verification budget (no budget change)', async () => {
    // Instructions are counted per request against verifyInputTokens; the schema is covered by
    // VERIFY_REQUEST_OVERHEAD_CHARS together with message framing.
    expect(text.length).toBeLessThanOrEqual(4_200);
    const schema = JSON.stringify(await zodSchema(verificationSchema as never).jsonSchema);
    expect(schema.length).toBeLessThanOrEqual(VERIFY_REQUEST_OVERHEAD_CHARS - 200);
  });
});
