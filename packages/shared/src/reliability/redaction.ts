import { redactForMemoryLog } from '../project-memory/secrets';
import {
  RELIABILITY_MAX_PROMPT_SNAPSHOT_CHARS,
  RELIABILITY_MAX_SAFE_METADATA_CHARS,
} from './budgets';

/**
 * Redact secrets before any reliability/audit persistence or hashing.
 * Reuses Day 22 memory redaction patterns.
 */
export function redactForReliability(text: string): string {
  return redactForMemoryLog(text);
}

export function truncateSafeText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function sanitizeSafeMetadata(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (
      lower.includes('token') ||
      lower.includes('password') ||
      lower.includes('secret') ||
      lower.includes('authorization') ||
      lower.includes('cookie') ||
      lower.includes('apikey') ||
      lower === 'api_key' ||
      lower === 'jwt'
    ) {
      out[key] = '[REDACTED]';
      continue;
    }
    if (typeof value === 'string') {
      out[key] = truncateSafeText(redactForReliability(value), RELIABILITY_MAX_SAFE_METADATA_CHARS);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value
        .slice(0, 20)
        .map((item) =>
          typeof item === 'string'
            ? truncateSafeText(redactForReliability(item), 200)
            : typeof item === 'number' || typeof item === 'boolean' || item === null
              ? item
              : '[omitted]',
        );
    } else {
      out[key] = '[omitted]';
    }
  }
  return out;
}

export function preparePromptSnapshotBody(raw: string): {
  body: string;
  truncated: boolean;
  redacted: boolean;
} {
  const redacted = redactForReliability(raw);
  const wasRedacted = redacted !== raw;
  if (redacted.length <= RELIABILITY_MAX_PROMPT_SNAPSHOT_CHARS) {
    return { body: redacted, truncated: false, redacted: wasRedacted };
  }
  return {
    body: truncateSafeText(redacted, RELIABILITY_MAX_PROMPT_SNAPSHOT_CHARS),
    truncated: true,
    redacted: wasRedacted,
  };
}
