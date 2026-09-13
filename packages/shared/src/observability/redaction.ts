/**
 * Day 26 — centralized recursive redaction for logs/errors/traces/client telemetry.
 * Redact BEFORE serialization. Never redact after log output.
 */

export const REDACTED = '[REDACTED]' as const;

const SENSITIVE_KEY_RE =
  /^(authorization|cookie|set-cookie|token|accesstoken|refreshtoken|apikey|api_key|secret|password|clientsecret|webhooksecret|privatekey|credential|paddle.?secret|auth.?token)$/i;

const SENSITIVE_KEY_SUBSTRINGS = [
  'authorization',
  'cookie',
  'token',
  'secret',
  'password',
  'apikey',
  'api_key',
  'privatekey',
  'credential',
  'webhooksecret',
  'clientsecret',
] as const;

export interface RedactionLimits {
  maxDepth: number;
  maxStringLength: number;
  maxArrayLength: number;
  maxObjectKeys: number;
  maxSerializedBytes: number;
}

export const DEFAULT_REDACTION_LIMITS: RedactionLimits = {
  maxDepth: 6,
  maxStringLength: 512,
  maxArrayLength: 32,
  maxObjectKeys: 64,
  maxSerializedBytes: 8_192,
};

export interface RedactResult<T> {
  value: T;
  truncated: boolean;
}

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_RE.test(key)) return true;
  const lower = key.toLowerCase().replace(/[-_\s]/g, '');
  return SENSITIVE_KEY_SUBSTRINGS.some((part) => lower.includes(part.replace(/_/g, '')));
}

/** Pattern-based redaction for free-form strings. */
export function redactSensitiveString(text: string): string {
  if (!text) return text;
  let output = text;

  output = output.replace(/(Authorization:\s*Bearer\s+)\S+/gi, `$1${REDACTED}`);
  output = output.replace(
    /\bBearer\s+(ey[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9._~+/=-]{16,})/gi,
    `Bearer ${REDACTED}`,
  );
  output = output.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}/g, REDACTED);
  output = output.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED);
  output = output.replace(/\bpdl_(?:live|test|sdbx)_[A-Za-z0-9_]+/gi, REDACTED);
  output = output.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
  output = output.replace(/\bsk-[A-Za-z0-9_-]{10,}/g, REDACTED);
  output = output.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED);
  output = output.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  );
  output = output.replace(
    /\b(password|passwd|secret|api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|client[_-]?secret|webhook[_-]?secret|token)\s*([=:])\s*(["']?)([^\s"'\\]+)\3/gi,
    (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`,
  );

  return output;
}

function truncateString(value: string, max: number): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  return { value: `${value.slice(0, Math.max(0, max - 1))}…`, truncated: true };
}

/**
 * Recursively redact sensitive keys/values and bound size.
 * Safe against circular references.
 */
export function redactForTelemetry(
  input: unknown,
  limits: RedactionLimits = DEFAULT_REDACTION_LIMITS,
): RedactResult<unknown> {
  let truncated = false;
  const seen = new WeakSet<object>();

  function walk(value: unknown, depth: number): unknown {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      const redacted = redactSensitiveString(value);
      const cut = truncateString(redacted, limits.maxStringLength);
      if (cut.truncated) truncated = true;
      return cut.value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') return value;

    if (typeof value === 'bigint') return value.toString();

    if (typeof value === 'symbol' || typeof value === 'function') {
      return `[${typeof value}]`;
    }

    if (depth >= limits.maxDepth) {
      truncated = true;
      return '[max_depth]';
    }

    if (Array.isArray(value)) {
      if (seen.has(value)) {
        truncated = true;
        return '[circular]';
      }
      seen.add(value);
      const slice = value.slice(0, limits.maxArrayLength);
      if (value.length > limits.maxArrayLength) truncated = true;
      return slice.map((item) => walk(item, depth + 1));
    }

    if (typeof value === 'object') {
      if (seen.has(value as object)) {
        truncated = true;
        return '[circular]';
      }
      seen.add(value as object);

      if (value instanceof Error) {
        return {
          name: value.name,
          message: walk(value.message, depth + 1),
        };
      }

      if (value instanceof Date) {
        return value.toISOString();
      }

      const entries = Object.entries(value as Record<string, unknown>);
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const [key, child] of entries) {
        if (count >= limits.maxObjectKeys) {
          truncated = true;
          out._truncatedKeys = true;
          break;
        }
        count += 1;
        if (isSensitiveKey(key)) {
          out[key] = REDACTED;
          continue;
        }
        out[key] = walk(child, depth + 1);
      }
      return out;
    }

    return String(value);
  }

  const value = walk(input, 0);

  try {
    const serialized = JSON.stringify(value) ?? '';
    if (serialized.length > limits.maxSerializedBytes) {
      truncated = true;
      return {
        value: {
          truncated: true,
          preview: serialized.slice(0, limits.maxSerializedBytes),
        },
        truncated: true,
      };
    }
  } catch {
    truncated = true;
    return { value: { truncated: true, error: 'serialize_failed' }, truncated: true };
  }

  return { value, truncated };
}

/**
 * Produce safe metadata for structured logs.
 * Always includes `truncated=true` when bounds were hit.
 */
export function safeTelemetryMetadata(
  input: Record<string, unknown> | undefined,
  limits: RedactionLimits = DEFAULT_REDACTION_LIMITS,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const { value, truncated } = redactForTelemetry(input, limits);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return truncated ? { value, truncated: true } : { value };
  }
  const record = value as Record<string, unknown>;
  if (truncated) {
    return { ...record, truncated: true };
  }
  return record;
}
