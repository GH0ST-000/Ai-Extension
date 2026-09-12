/**
 * Detect and redact sensitive content before it can enter project memory.
 * Patterns mirror apps/api CI log sanitization, without Nest dependencies.
 */

const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bBearer\s+(ey[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9._~+/=-]{16,})/gi,
  /\bAuthorization:\s*Bearer\s+\S+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(password|passwd|secret|api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|client[_-]?secret|token)\s*([=:])\s*(["']?)([^\s"'\\]+)\3/gi,
];

export function containsSensitiveMemoryContent(text: string): boolean {
  if (!text) return false;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

export function redactForMemoryLog(text: string): string {
  if (!text) return '';
  let output = text;

  output = output.replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1[REDACTED]');
  output = output.replace(
    /\bBearer\s+(ey[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9._~+/=-]{16,})/gi,
    'Bearer [REDACTED]',
  );
  output = output.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED]');
  output = output.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]');
  output = output.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
  output = output.replace(/\bsk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]');
  output = output.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]');
  output = output.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  );
  output = output.replace(
    /\b(password|passwd|secret|api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|client[_-]?secret|token)\s*([=:])\s*(["']?)([^\s"'\\]+)\3/gi,
    (_match, key: string, sep: string) => `${key}${sep}[REDACTED]`,
  );

  return output;
}
