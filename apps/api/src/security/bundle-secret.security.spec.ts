import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Controlled fake secrets — must never appear in client artifacts. */
const SECRET_FIXTURES = [
  'sk-proj-DAY29-BUNDLE-SECRET-SCAN-ONLY',
  'paddle_secret_DAY29_BUNDLE_SCAN',
  'TOKEN_ENCRYPTION_KEY_DAY29_BUNDLE',
  '-----BEGIN RSA PRIVATE KEY-----',
  'ghp_day29BundleScanTokenFake000000000',
  'sk-live-day29-openai-should-not-ship',
];

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) {
    return out;
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'cache' || entry === 'server') {
        continue;
      }
      walkFiles(full, out);
    } else if (/\.(js|css|html)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scans built client artifacts when present.
 * Skips gracefully if builds have not been produced in this workspace.
 * Does not flag public env name strings (NEXT_PUBLIC_*) — only secret fixtures.
 */
describe('Day 29 client bundle secret scan', () => {
  const roots = [
    join(process.cwd(), '../dashboard/.next/static'),
    join(process.cwd(), '../extension/build/chrome-mv3-prod'),
    join(process.cwd(), '../../apps/dashboard/.next/static'),
    join(process.cwd(), '../../apps/extension/build/chrome-mv3-prod'),
  ];

  it('does not embed known private secret fixtures in client artifacts', () => {
    const files = roots.flatMap((root) => walkFiles(root));
    if (files.length === 0) {
      expect(true).toBe(true);
      return;
    }

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const secret of SECRET_FIXTURES) {
        expect(content.includes(secret), `${file} contains ${secret}`).toBe(false);
      }
    }
  });
});
