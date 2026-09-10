/**
 * Conservative secret redaction for untrusted error/log text before AI send.
 * Does not attempt enterprise DLP — only obvious credential patterns.
 *
 * Intentionally does NOT redact identifiers like `passwordValidator`.
 */
export function redactSensitiveText(text: string): { text: string; redacted: boolean } {
  if (!text) {
    return { text: '', redacted: false };
  }

  let redacted = false;
  let output = text;

  const apply = (next: string) => {
    if (next !== output) {
      redacted = true;
    }
    output = next;
  };

  apply(output.replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1[REDACTED]'));
  apply(
    output.replace(
      /\bBearer\s+(ey[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9._~+/=-]{16,})/gi,
      'Bearer [REDACTED]',
    ),
  );
  apply(output.replace(/\bsk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]'));

  // key=value / key: value — require an assignment so identifiers stay intact
  apply(
    output.replace(
      /\b(OPENAI_API_KEY|api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token)\s*([=:])\s*(["']?)([^\s"'\\]+)\3/gi,
      (_match, key: string, sep: string) => `${key}${sep}[REDACTED]`,
    ),
  );

  return { text: output, redacted };
}
