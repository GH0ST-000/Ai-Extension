/**
 * Secret redaction for content sent to external AI providers (diffs, code, page context,
 * selections, Project Memory).
 *
 * Unlike the telemetry redactor (observability/redaction.ts), this one must keep code
 * reviewable: it only replaces values that are recognizably credentials and preserves
 * everything around them — line count, diff markers (`+`/`-`/` `), hunk headers, quotes,
 * keys, file paths, API paths, schema property names and types. Rules are conservative:
 * a type annotation (`token: string`), a reference (`process.env.API_KEY`), a template
 * (`${password}`), an env-var name or a placeholder value is left alone.
 *
 * Properties: deterministic (fixed placeholders, the original value is never stored),
 * idempotent (placeholders are never re-matched), line-preserving (output has exactly the
 * same number of lines), linear-time (bounded quantifiers, no ambiguous adjacent repeats).
 *
 * Limitation: arbitrary high-entropy strings without a recognizable format or a
 * credential-like name are NOT redacted (see docs in the M6 report).
 */

export const AI_SECRET_PLACEHOLDER = '[REDACTED_SECRET]';
export const AI_PRIVATE_KEY_PLACEHOLDER = '[REDACTED_PRIVATE_KEY]';

const P = AI_SECRET_PLACEHOLDER;

/** Recognizable credential formats (stateless, one line at a time). */
const TOKEN_RULES: ReadonlyArray<{
  re: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}> = [
  // Private key fully on one line (JSON / env with \n escapes).
  {
    // Between the markers only what a key consists of (base64, whitespace, `\n` / `\r`
    // escapes, armor-header punctuation) — never code: `"-----BEGIN…"; steal(); "-----END…"`
    // on one line is two string literals with a statement between them, not a key.
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:[A-Za-z0-9+/=\s:,.]|-(?!----)|\\[nr]){0,16384}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g,
    replace: () => AI_PRIVATE_KEY_PLACEHOLDER,
  },
  // Authorization header values (keep the scheme).
  {
    re: /\b(authorization["']?[ \t]{0,3}[:=][ \t]{0,3}["']?(?:bearer|basic|token|bot)[ \t])([A-Za-z0-9._~+/=-]{8,4096})/gi,
    replace: (_m, head: string) => `${head}${P}`,
  },
  // Bare bearer tokens (must look like a token: contains a digit or is long).
  {
    re: /\b(bearer[ \t])([A-Za-z0-9._~+/-]{20,4096}=*)/gi,
    replace: (m, head: string, token: string) =>
      /\d/.test(token) || token.length >= 32 ? `${head}${P}` : m,
  },
  // JWTs.
  {
    re: /\beyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g,
    replace: () => P,
  },
  // GitHub tokens: classic / OAuth / user-to-server / server-to-server / refresh; fine-grained.
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/g, replace: () => P },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,255}\b/g, replace: () => P },
  // OpenAI / Anthropic style keys (must contain a digit: avoids `sk-learn-...` names).
  {
    re: /\bsk-[A-Za-z0-9_-]{20,255}/g,
    replace: (m) => (/\d/.test(m.slice(3)) ? P : m),
  },
  // Stripe secret / restricted keys and webhook secrets (publishable pk_ keys are public).
  { re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}\b/g, replace: () => P },
  { re: /\bwhsec_[A-Za-z0-9+/=]{16,255}/g, replace: () => P },
  // Paddle API keys.
  { re: /\bpdl_(?:live|test|sdbx)_[A-Za-z0-9_]{10,255}/gi, replace: () => P },
  // AWS access key ids.
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => P },
  // Slack tokens and incoming-webhook secrets.
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,255}/g, replace: () => P },
  {
    re: /(hooks\.slack\.com\/services\/[A-Z0-9]{6,32}\/[A-Z0-9]{6,32}\/)([A-Za-z0-9]{16,64})/g,
    replace: (_m, head: string) => `${head}${P}`,
  },
  { re: /\bxapp-[A-Za-z0-9-]{10,255}/g, replace: () => P },
  // Google API keys and OAuth client secrets.
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => P },
  { re: /\bGOCSPX-[A-Za-z0-9_-]{20,64}/g, replace: () => P },
  // npm, GitLab, Hugging Face, SendGrid, Twilio API key secrets.
  { re: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: () => P },
  { re: /\bglpat-[A-Za-z0-9_-]{20,255}/g, replace: () => P },
  { re: /\bhf_[A-Za-z0-9]{30,255}\b/g, replace: () => P },
  { re: /\bSG\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{16,128}/g, replace: () => P },
  { re: /\bSK[0-9a-fA-F]{32}\b/g, replace: () => P },
  // Sentry DSN key (https://<key>@oNNN.ingest.sentry.io/...).
  {
    re: /(https?:\/\/)([0-9a-f]{32})(@[A-Za-z0-9.-]{0,128}sentry\.io)/gi,
    replace: (_m, scheme: string, _key: string, host: string) => `${scheme}${P}${host}`,
  },
  // Credentials embedded in URLs: scheme://user:password@host. The password may itself
  // contain `@` or `/`: everything up to the LAST `@` that is followed by a host is replaced
  // (templates are kept).
  {
    re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"'`]{0,128}:)([^\s"'`]{1,256})@(?=[A-Za-z0-9[\]._-]{1,253}(?:[:/?#\s"'`]|$))/gi,
    replace: (m, head: string, password: string) =>
      isPlaceholderValue(password) ? m : `${head}${P}@`,
  },
  // Secret-bearing query-string parameters (?access_token=…, &api_key=…, &sig=…).
  {
    re: /([?&](?:access_token|refresh_token|id_token|api[_-]?key|apikey|token|secret|client_secret|password|passwd|sig|signature|auth|key)=)([^&\s#"'`]{8,512})/gi,
    replace: (m, head: string, value: string) => (isPlaceholderValue(value) ? m : `${head}${P}`),
  },
  // Connection-string segments (`Server=db;User Id=sa;Password=…;`, Azure `AccountKey=…`):
  // only a `;`-separated `Key=value` with no spaces around `=`, so code is not affected.
  {
    re: /(;[ \t]{0,2}(?:password|pwd|accountkey|sharedaccesskey|sharedsecret)=)([^;"'`\s]{4,256})/gi,
    replace: (m, head: string, value: string) => (isPlaceholderValue(value) ? m : `${head}${P}`),
  },
  // curl / httpie basic credentials: `-u user:password`, `--user user:password`.
  {
    re: /((?:^|\s)(?:-u|--user)[ \t]+["']?[^\s:"']{1,128}:)([^\s"']{4,256})/g,
    replace: (m, head: string, password: string) =>
      isPlaceholderValue(password) ? m : `${head}${P}`,
  },
];

/** Key names whose literal values are credentials (matched on the normalized key's END). */
const SENSITIVE_KEY_ENDINGS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'secretkey',
  'clientsecret',
  'webhooksecret',
  'apikey',
  'accesskey',
  'privatekey',
  'token',
  'accesstoken',
  'authtoken',
  'refreshtoken',
  'credential',
  'credentials',
  'connectionstring',
] as const;

/** Whole key names (normalized) that hold credentials but are too short for an ending rule. */
const SENSITIVE_KEY_NAMES = new Set(['pass', 'pwd', 'dsn', 'auth', 'sentrydsn', 'secretkeybase']);

/** Endings that are credentials only in key names like signingKey / ENCRYPTION_KEY. */
const SENSITIVE_KEY_SUFFIX_ENDINGS = [
  'signingkey',
  'encryptionkey',
  'masterkey',
  'hmackey',
  'licensekey',
  'dsn',
] as const;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_KEY_ENDINGS.some((ending) => normalized.endsWith(ending))) return true;
  if (SENSITIVE_KEY_NAMES.has(normalized)) return true;
  if (SENSITIVE_KEY_SUFFIX_ENDINGS.some((ending) => normalized.endsWith(ending))) return true;
  // Environment-style names ending in _KEY (STRIPE_KEY, DD_API_KEY, SECRET_KEY_BASE): only
  // the UPPER_CASE convention, so code identifiers like cacheKey / sortKey are not affected.
  return /^[A-Z][A-Z0-9_]*_KEY(?:_BASE)?$/.test(key);
}

/** Keys whose bare (unquoted) values are credentials even without digits. */
function isPasswordKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(?:password|passwd|passphrase|secret)$/.test(normalized);
}

/** Words that are never secrets when they are the whole value. */
const NON_SECRET_VALUES = new Set([
  'bearer',
  'basic',
  'string',
  'number',
  'boolean',
  'null',
  'undefined',
  'true',
  'false',
  'required',
  'optional',
  'password',
  'secret',
  'token',
  'hidden',
  'text',
  'redacted',
  'changeme',
  'example',
  'placeholder',
]);

function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  if (v.includes('[REDACTED')) return true;
  if (v.includes('${') || v.includes('{{') || v.startsWith('$') || v.startsWith('%')) return true;
  if (v.startsWith('<') && v.endsWith('>')) return true; // <your-token>
  if (/^[*xX•.-]+$/.test(v)) return true; // ****, xxxx
  if (/^your[-_ ]/i.test(v) || /[-_]here$/i.test(v)) return true; // your-api-key, key_here
  return NON_SECRET_VALUES.has(v.toLowerCase());
}

/** A literal assigned to a credential-like key that plausibly IS a credential. */
function isSecretLikeLiteral(value: string): boolean {
  if (value.length < 8 || value.length > 512) return false;
  if (/\s/.test(value)) return false; // prose, messages, descriptions
  if (isPlaceholderValue(value)) return false;
  // Names an env var (GITHUB_TOKEN, OAUTH2_CLIENT_SECRET). An upper-case run with digits and
  // no underscore is not a name — it is base32 / hex material (a TOTP seed, an access key).
  if (/^[A-Z][A-Z0-9_]*$/.test(value) && !(/\d/.test(value) && !value.includes('_'))) {
    return false;
  }
  if (/^(?:https?:\/\/|\/|\.\.?\/)/.test(value)) return false; // URLs / paths (creds handled above)
  if (/^\d+$/.test(value)) return false;
  if (/^(.)\1+$/.test(value)) return false;
  return true;
}

/**
 * Unquoted values need stronger evidence: letters AND digits, no code punctuation — or, for
 * password/secret keys, a long letters-only value (`password: correcthorsebattery`).
 */
function isSecretLikeBareValue(value: string, key: string): boolean {
  if (!isSecretLikeLiteral(value)) return false;
  if (/[A-Za-z]/.test(value) && /\d/.test(value)) return true;
  return isPasswordKey(key) && value.length >= 10 && /^[A-Za-z][A-Za-z_-]*$/.test(value);
}

// `key = "value"`, `"key": "value"`, `key: 'value'` (JSON, YAML, JS/TS, Python, env).
const QUOTED_ASSIGNMENT_RE =
  /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,63})\1([ \t]{0,8}(?::=|=>|[:=])[ \t]{0,8})(["'`])([^"'`\n]{1,512})\4/g;
// `KEY=value` / `key: value` ending the line (env files, YAML), optionally with a # comment.
const BARE_ASSIGNMENT_RE =
  /(^|[\s{,(+-])([A-Za-z_][A-Za-z0-9_.-]{0,63})([ \t]{0,8}(?::=|=>|[:=])[ \t]{0,8})([^\s"'`,;{}()[\]<>]{8,512})(?=[ \t]*(?:;[ \t]*)?(?:#.*)?$)/g;

function redactAssignments(line: string): string {
  let out = line.replace(
    QUOTED_ASSIGNMENT_RE,
    (m, keyQuote: string, key: string, sep: string, valueQuote: string, value: string) =>
      isSensitiveKey(key) && isSecretLikeLiteral(value)
        ? `${keyQuote}${key}${keyQuote}${sep}${valueQuote}${P}${valueQuote}`
        : m,
  );
  out = out.replace(
    BARE_ASSIGNMENT_RE,
    (m, lead: string, key: string, sep: string, value: string) =>
      isSensitiveKey(key) && isSecretLikeBareValue(value, key) ? `${lead}${key}${sep}${P}` : m,
  );
  return out;
}

function redactLine(line: string): string {
  let out = line;
  for (const rule of TOKEN_RULES) {
    out = out.replace(rule.re, rule.replace as (substring: string, ...args: string[]) => string);
  }
  return redactAssignments(out);
}

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END_RE = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
/**
 * Prefixes a key line may carry in content sent to the model, kept verbatim: line-number
 * labels of rendered context (`12: `, `HEAD      12 | `, `BASE 7 | `), then an optional diff
 * marker, then an optional comment marker (a commented-out key: `# MIIE…`, `// MIIE…`,
 * `* MIIE…`, `> MIIE…`). (`+` and `/` are also base64 characters, so each is only taken once,
 * as the first characters.)
 */
const KEY_LINE_PREFIX_RE =
  /^((?:[ \t]{0,8}(?:HEAD|BASE)?[ \t]{0,8}\d{1,7}[ \t]{0,4}[:|][ \t]?)?[+ -]?(?:[ \t]{0,8}(?:#|\/\/|\*|>)[ \t]{0,4})?)/;
/**
 * PEM / PGP armor header lines. F-22: only the real header names, each with a value of the
 * shape that header has, at most {@link MAX_KEY_HEADER_LINES} of them, and only before the
 * first line of key material. `Comment: fetch("https://evil")` or `Version: grantAdmin(user)`
 * are labelled statements, not headers, so a fake BEGIN marker cannot hide them.
 */
const KEY_HEADER_RE =
  /^[ \t]{0,8}(?:Proc-Type:[ \t]\d,[A-Z-]{1,20}|DEK-Info:[ \t][A-Z0-9-]{1,40},[0-9A-Fa-f]{1,128}|(?:Version|Comment|Hash|Charset|MessageID):[ \t][^(){}[\];=`$<>"'\\]{0,200})$/;
const MAX_KEY_HEADER_LINES = 6;
/** Base64 runs inside a key block (two or more characters; padding included). */
const KEY_MATERIAL_RE = /[A-Za-z0-9+/=]{2,}/g;
const MAX_PEM_LINES = 400;
/**
 * Shortest line accepted as a FULL line of key material (PEM wraps at 64, OpenSSH at 70, PGP
 * at 64/76). A shorter run is key material only as the final line(s) of a block.
 */
const MIN_FULL_KEY_LINE = 40;

/**
 * Does a full-width run look like base64 of random bytes rather than an identifier? 40+
 * characters of key material contain upper case, lower case and a digit / `+` / `/` with
 * overwhelming probability; `disableSignatureVerificationForAllRequests` does not.
 */
function looksLikeKeyMaterial(run: string): boolean {
  return /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9+/]/.test(run);
}

/**
 * The key material on `rest` (a line without its prefix): `''` for a blank line, the base64
 * run when the line is exactly ONE base64 run optionally wrapped in string-literal syntax
 * (an assignment target `key +=`, a literal prefix `b"` / `f"` / `r"` / `@"`, quotes, `\n`
 * escapes, `+` / `,` concatenation, enclosing parentheses, a trailing `;`), or null for
 * anything else. F-22: several runs on one line (`eval(atob("…"))`, `a b`) and call syntax
 * (`name(…)`) are code or prose, never key material.
 */
function keyMaterialOf(rest: string): string | null {
  const text = rest
    // `key = `, `key += `, `"key": ` before the literal.
    .replace(
      /^[ \t]{0,64}["']?[A-Za-z_][\w.-]{0,63}["']?[ \t]{0,8}(?:\+?=|:)[ \t]{0,8}(?=[bBrRfFuU@$]{0,2}["'`(])/,
      '',
    )
    // String-literal prefixes: b"…", rb'…', f"…", @"…", $"…".
    .replace(/(^|[\s(+,])[bBrRfFuU@$]{1,2}(?=["'`])/g, '$1')
    .replace(/\\[nr]/g, ' ');
  // A name directly followed by `(` is a call, not a parenthesized string.
  if (/[A-Za-z0-9_]\(/.test(text)) return null;
  const tokens = text.split(/[\s"'`,;()\\]+/).filter((t) => t.length > 0 && !/^\++$/.test(t));
  if (tokens.length === 0) return '';
  if (tokens.length > 1) return null;
  return /^[A-Za-z0-9+/=]+$/.test(tokens[0]!) ? tokens[0]! : null;
}

/** A line that is a full-width run of plausible key material. */
function isFullKeyLine(material: string | null): boolean {
  return (
    material !== null && material.length >= MIN_FULL_KEY_LINE && looksLikeKeyMaterial(material)
  );
}

/** An END marker standing alone on its line (string-literal wrapping aside). */
const LONE_END_RE =
  /^[\s"'`+,;()\\]*-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:\\[nr])?[\s"'`+,;()\\]*$/;

function splitKeyLine(line: string): { prefix: string; rest: string } {
  let prefix = KEY_LINE_PREFIX_RE.exec(line)?.[1] ?? '';
  // `-` is a diff marker and also the first character of a `-----BEGIN` / `-----END` marker:
  // when taking it as a diff marker would leave a four-dash marker, it belongs to the marker.
  if (prefix.endsWith('-') && /^----(?:BEGIN|END) /.test(line.slice(prefix.length))) {
    prefix = prefix.slice(0, -1);
  }
  return { prefix, rest: line.slice(prefix.length) };
}

/**
 * A short run closes a key block: it is followed (blank lines aside) by the END marker, by one
 * more short run and then END (PGP: last data line, `=checksum`, END), or by nothing at all
 * (a key cut off by the end of a hunk or of a size budget).
 */
function shortRunEndsBlock(lines: readonly string[], index: number): boolean {
  let allowance = 1;
  for (let i = index + 1; i < lines.length && i <= index + 6; i += 1) {
    const { rest } = splitKeyLine(lines[i]!);
    if (PEM_END_RE.test(rest)) return true;
    const material = keyMaterialOf(rest);
    if (material === '') continue;
    if (material !== null && material.length < MIN_FULL_KEY_LINE && allowance > 0) {
      allowance -= 1;
      continue;
    }
    return false;
  }
  return true;
}

function redactKeyMaterial(prefix: string, rest: string): string {
  return prefix + rest.replace(KEY_MATERIAL_RE, AI_PRIVATE_KEY_PLACEHOLDER);
}

/**
 * Redact secrets in a sequence of lines. Multi-line private keys (PEM, OpenSSH, PGP — also
 * encrypted, unwrapped, string-concatenated, commented out, or rendered with line numbers)
 * are tracked from BEGIN until END; every other rule works per line. Returns the same number
 * of lines, each with the line ending it came with.
 *
 * F-08: a trailing `\r` (CRLF files — GitHub patches and raw contents keep it) is set aside
 * before matching and restored afterwards; the end-anchored rules would otherwise never match.
 */
export function redactSecretLines(input: readonly string[]): string[] {
  const carriage = input.map((line) => line.endsWith('\r'));
  const lines = input.map((line, i) => (carriage[i] ? line.slice(0, -1) : line));
  const out: string[] = [];
  let inKey = false;
  let keyLines = 0;
  let headerLines = 0;
  let sawMaterial = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (inKey) {
      const { prefix, rest } = splitKeyLine(line);
      const end = PEM_END_RE.exec(rest);
      if (end) {
        const before = rest
          .slice(0, end.index)
          .replace(KEY_MATERIAL_RE, AI_PRIVATE_KEY_PLACEHOLDER);
        out.push(prefix + redactLine(before + rest.slice(end.index)));
        inKey = false;
        continue;
      }
      if (keyLines < MAX_PEM_LINES) {
        if (!sawMaterial && headerLines < MAX_KEY_HEADER_LINES && KEY_HEADER_RE.test(rest)) {
          // KEY_HEADER_RE guarantees `Name: value`: cut at the first colon (no regex scan).
          out.push(`${prefix}${rest.slice(0, rest.indexOf(':'))}: ${AI_PRIVATE_KEY_PLACEHOLDER}`);
          keyLines += 1;
          headerLines += 1;
          continue;
        }
        const material = keyMaterialOf(rest);
        if (material === '') {
          out.push(line);
          keyLines += 1;
          continue;
        }
        if (
          isFullKeyLine(material) ||
          (material !== null &&
            material.length < MIN_FULL_KEY_LINE &&
            shortRunEndsBlock(lines, index))
        ) {
          out.push(redactKeyMaterial(prefix, rest));
          keyLines += 1;
          sawMaterial = true;
          continue;
        }
      }
      inKey = false; // not key content: process normally
    }
    const redacted = redactLine(line);
    const begin = PEM_BEGIN_RE.exec(redacted);
    if (begin && !PEM_END_RE.test(redacted.slice(begin.index))) {
      const markerEnd = begin.index + begin[0].length;
      out.push(
        redacted.slice(0, markerEnd) +
          redacted.slice(markerEnd).replace(/[A-Za-z0-9+/=]{16,}/g, AI_PRIVATE_KEY_PLACEHOLDER),
      );
      inKey = true;
      keyLines = 0;
      headerLines = 0;
      sawMaterial = false;
      continue;
    }
    if (!begin && LONE_END_RE.test(splitKeyLine(redacted).rest)) {
      // The tail of a key whose BEGIN line is outside this text (a diff hunk that starts
      // mid-key). Deliberately narrow, so a fake END marker cannot be used to hide code: the
      // marker must stand alone on its line, and directly above it there must be at least
      // TWO consecutive full-width lines of plausible key material (after at most two short
      // closing lines: the last data line and a PGP checksum).
      const candidates: number[] = [];
      let fullLines = 0;
      let shortAllowance = 2;
      for (let j = out.length - 1; j >= 0 && candidates.length < MAX_PEM_LINES; j -= 1) {
        const material = keyMaterialOf(splitKeyLine(out[j]!).rest);
        if (material === null || material === '') break;
        if (isFullKeyLine(material)) {
          fullLines += 1;
          shortAllowance = 0;
        } else if (material.length < MIN_FULL_KEY_LINE && shortAllowance > 0) {
          shortAllowance -= 1;
        } else {
          break;
        }
        candidates.push(j);
      }
      if (fullLines >= 2) {
        for (const j of candidates) {
          const { prefix, rest } = splitKeyLine(out[j]!);
          out[j] = redactKeyMaterial(prefix, rest);
        }
      }
    }
    out.push(redacted);
  }
  return out.map((line, i) => (carriage[i] ? `${line}\r` : line));
}

/** Redact secrets in free text (line-preserving). */
export function redactSecretsForAi(text: string): string {
  if (!text) return text;
  return redactSecretLines(text.split('\n')).join('\n');
}

/** True when the text contains something the redactor would replace. */
export function containsRedactableSecret(text: string): boolean {
  return redactSecretsForAi(text) !== text;
}
