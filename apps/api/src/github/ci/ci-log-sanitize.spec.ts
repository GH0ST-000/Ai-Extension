import { describe, expect, it } from 'vitest';

import {
  isSafeHttpsUrl,
  redactSensitiveCiText,
  sanitizeCiLogText,
  stripAnsiAndControls,
} from './ci-log-sanitize';

describe('ci-log-sanitize', () => {
  it('strips ANSI color codes', () => {
    const input = '\u001B[31mFAIL\u001B[0m next';
    expect(stripAnsiAndControls(input)).toBe('FAIL next');
  });

  it('redacts tokens and keys', () => {
    const { text, redacted } = redactSensitiveCiText(
      'Authorization: Bearer ghp_abcdefghijklmnopqrstuv\nAWS key AKIAIOSFODNN7EXAMPLE',
    );
    expect(redacted).toBe(true);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('AKIA');
  });

  it('sanitizes combined ANSI + secrets', () => {
    const { text } = sanitizeCiLogText('\u001B[32mtoken=supersecretvalue123\u001B[0m');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('\u001B');
  });

  it('rejects unsafe URL schemes', () => {
    expect(isSafeHttpsUrl('javascript:alert(1)')).toBeUndefined();
    expect(isSafeHttpsUrl('http://example.com')).toBeUndefined();
    expect(isSafeHttpsUrl('https://github.com/a/b')).toBe('https://github.com/a/b');
  });
});
