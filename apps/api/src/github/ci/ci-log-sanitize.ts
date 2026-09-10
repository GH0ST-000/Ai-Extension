/**
 * Sanitize CI logs: strip ANSI/control sequences, then redact obvious secrets.
 * Logs are untrusted input — never execute or render as HTML.
 */

const ANSI_ESCAPE =
  // eslint-disable-next-line no-control-regex -- intentional control-char stripping
  /(?:\u001B|\u009B)(?:[@-Z\\-_]|[[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><])/g;

// eslint-disable-next-line no-control-regex -- strip other C0 controls except \t \n \r
const OTHER_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripAnsiAndControls(text: string): string {
  return text.replace(ANSI_ESCAPE, '').replace(OTHER_CONTROLS, '');
}

export function redactSensitiveCiText(text: string): { text: string; redacted: boolean } {
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
  apply(output.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED]'));
  apply(output.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'));
  apply(output.replace(/\bsk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]'));
  apply(output.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'));
  apply(
    output.replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      '[REDACTED_PRIVATE_KEY]',
    ),
  );
  apply(
    output.replace(
      /\b(OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token)\s*([=:])\s*(["']?)([^\s"'\\]+)\3/gi,
      (_match, key: string, sep: string) => `${key}${sep}[REDACTED]`,
    ),
  );
  apply(output.replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1[REDACTED]:[REDACTED]@'));

  return { text: output, redacted };
}

export function sanitizeCiLogText(text: string): { text: string; redacted: boolean } {
  const stripped = stripAnsiAndControls(text);
  return redactSensitiveCiText(stripped);
}

export function isSafeHttpsUrl(url: string | null | undefined): string | undefined {
  if (!url || typeof url !== 'string') {
    return undefined;
  }
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return undefined;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}

/** Prefer github.com / *.github.com / *.githubusercontent.com details links. */
export function isTrustedGitHubDetailsUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'github.com' ||
      host.endsWith('.github.com') ||
      host === 'githubusercontent.com' ||
      host.endsWith('.githubusercontent.com')
    );
  } catch {
    return false;
  }
}
