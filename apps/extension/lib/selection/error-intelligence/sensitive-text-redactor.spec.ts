import { describe, expect, it } from 'vitest';

import { redactSensitiveText } from './sensitive-text-redactor';

describe('redactSensitiveText', () => {
  it('redacts Authorization Bearer tokens', () => {
    const { text, redacted } = redactSensitiveText('Authorization: Bearer abc123');
    expect(text).toBe('Authorization: Bearer [REDACTED]');
    expect(redacted).toBe(true);
  });

  it('redacts OPENAI_API_KEY assignments', () => {
    const { text } = redactSensitiveText('OPENAI_API_KEY=sk-example-secret');
    expect(text).toBe('OPENAI_API_KEY=[REDACTED]');
  });

  it('redacts password values', () => {
    const { text } = redactSensitiveText('password=my-password');
    expect(text).toBe('password=[REDACTED]');
  });

  it('does not redact harmless identifier names', () => {
    const source = 'const passwordValidator = createValidator()';
    const { text, redacted } = redactSensitiveText(source);
    expect(text).toBe(source);
    expect(redacted).toBe(false);
  });
});
