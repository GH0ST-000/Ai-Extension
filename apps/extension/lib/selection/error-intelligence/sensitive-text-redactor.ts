import { REDACTED, redactSensitiveString } from '@project-x/shared';

/**
 * Conservative secret redaction for untrusted text before AI send.
 * Uses the shared pattern set (GitHub PATs, JWTs, AWS keys, PEM, etc.).
 */
export function redactSensitiveText(text: string): { text: string; redacted: boolean } {
  if (!text) {
    return { text: '', redacted: false };
  }

  const output = redactSensitiveString(text);
  return {
    text: output,
    redacted: output !== text || output.includes(REDACTED) || output.includes('[REDACTED_JWT]'),
  };
}
