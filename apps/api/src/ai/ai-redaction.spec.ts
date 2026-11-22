import { AI_SECRET_PLACEHOLDER as S } from '@project-x/shared';
import { describe, expect, it } from 'vitest';

import {
  redactChunkForAi,
  redactDiffFilesForAi,
  redactPlanForAi,
  sanitizeProviderPrompt,
} from './ai-redaction';
import { chunkPatch } from './pr-review/diff-hunks';
import { validateBatchFindings } from './pr-review/pr-review-findings';
import { rawFinding } from './pr-review/pr-review-fixtures';
import type { PrReviewPlan } from './pr-review/pr-review-plan';

const TOKEN = 'gh' + 'p_' + 'Ab1'.repeat(12); // synthetic
const PATCH = [
  '@@ -1,5 +1,6 @@ export const client = {',
  `-  token: "${TOKEN}",`,
  '+  token: process.env.GITHUB_TOKEN,',
  `+  fallbackToken: "${TOKEN}",`,
  '   users: await fetchUsers(),',
  `   headers: { Authorization: \`Bearer \${token}\` },`,
].join('\n');

function plan(): PrReviewPlan {
  const chunk = chunkPatch(PATCH, 10_000)[0]!;
  return {
    source: 'github_api',
    totalFiles: 1,
    notFetched: 0,
    files: [
      {
        path: 'src/client.ts',
        status: 'modified',
        category: 'source',
        priority: 1,
        patchChars: PATCH.length,
        chunks: [chunk],
        plannedChunks: [0],
        lineCut: false,
        excerpt: false,
      },
    ],
    batches: [
      {
        id: 'b1',
        diffChars: PATCH.length,
        units: [{ path: 'src/client.ts', chunkIndex: 0, chunkCount: 1, chunk }],
      },
    ],
  } as unknown as PrReviewPlan;
}

describe('AI transmission boundary (M6)', () => {
  it('redacts batch chunks consistently (text vs lines) and keeps line numbers and markers', () => {
    const original = plan();
    const redacted = redactPlanForAi(original);
    const chunk = redacted.batches[0]!.units[0]!.chunk;
    expect(chunk.text).not.toContain(TOKEN);
    expect(chunk.lines.map((l) => l.text).join('\n')).not.toContain(TOKEN);
    // Every body line of the prompt text is exactly kind + line text (what validation uses).
    const body = chunk.text.split('\n').filter((l) => !l.startsWith('@@'));
    expect(body).toEqual(chunk.lines.map((l) => `${l.kind}${l.text}`));
    expect(chunk.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual(
      original.batches[0]!.units[0]!.chunk.lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    );
    expect(chunk.text.split('\n')[0]).toBe('@@ -1,5 +1,6 @@ export const client = {');
    expect(chunk.text).toContain('Bearer ${token}'); // code, not a secret
  });

  it('does not mutate the plan, its files (coverage) or the source chunk', () => {
    const original = plan();
    const before = JSON.stringify(original);
    redactPlanForAi(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(original.files[0]!.chunks[0]!.text).toContain(TOKEN);
  });

  it('a finding quoting the redacted line still validates; quoting the secret cannot', () => {
    const batch = redactPlanForAi(plan()).batches[0]!;
    const quoted = `fallbackToken: "${S}",`;
    const ok = validateBatchFindings(
      {
        summary: 's',
        findings: [rawFinding({ path: 'src/client.ts', evidence: quoted, category: 'security' })],
      },
      batch,
    );
    expect(ok.findings).toHaveLength(1);
    expect(ok.findings[0]).toMatchObject({ path: 'src/client.ts', lineStart: 2 }); // head line
    const leaked = validateBatchFindings(
      {
        summary: 's',
        findings: [
          rawFinding({
            path: 'src/client.ts',
            evidence: `fallbackToken: "${TOKEN}",`,
            category: 'security',
          }),
        ],
      },
      batch,
    );
    expect(leaked.findings).toHaveLength(0);
  });

  it('chunks without secrets are returned as-is (no copies)', () => {
    const chunk = chunkPatch('@@ -1 +1 @@\n-a\n+b', 10_000)[0]!;
    expect(redactChunkForAi(chunk)).toBe(chunk);
  });

  it('provider prompts: instructions, string and multi-part messages; inputs untouched', () => {
    const messages = [
      { role: 'user', content: `key: "${TOKEN}"` },
      {
        role: 'user',
        content: [
          { type: 'text', text: `use ${TOKEN}` },
          { type: 'image', image: 'x' },
        ],
      },
    ];
    const prompt = { instructions: `never print ${TOKEN}`, messages };
    const out = sanitizeProviderPrompt(prompt);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.messages[1]!.content).toEqual([
      { type: 'text', text: `use ${S}` },
      { type: 'image', image: 'x' },
    ]);
    expect(JSON.stringify(prompt)).toContain(TOKEN); // original not mutated
    expect(sanitizeProviderPrompt(out)).toEqual(out); // idempotent
  });
});

describe('adversarial N1: a private key split across batch chunks', () => {
  const body = Array.from(
    { length: 40 },
    (_, i) =>
      `+${'MIIEowIBAAKCAQEAu1SU1Lf'}${String(i).padStart(4, '0')}VLPHCozMxH2Mo4lgOEePzNm0tRg`,
  );
  const patch = [
    '@@ -0,0 +1,44 @@',
    '+const KEY = `',
    '+-----BEGIN RSA PRIVATE KEY-----',
    ...body,
    '+-----END RSA PRIVATE KEY-----',
    '+`;',
  ].join('\n');
  const leaked = (texts: string[]) =>
    body.some((line) => texts.some((t) => t.includes(line.slice(1))));

  it('per-chunk redaction alone leaks the key lines of the second chunk (the bug)', () => {
    const chunks = chunkPatch(patch, 600);
    expect(chunks.length).toBeGreaterThan(1);
    expect(leaked(chunks.map((c) => redactChunkForAi(c).text))).toBe(true);
  });

  it('whole-file redaction before chunking leaks nothing and keeps the line count', () => {
    const [file] = redactDiffFilesForAi([{ filename: 'src/key.ts', patch }]);
    expect(file!.patch!.split('\n')).toHaveLength(patch.split('\n').length);
    const chunks = chunkPatch(file!.patch!, 600);
    expect(chunks.length).toBeGreaterThan(1);
    expect(leaked(chunks.map((c) => redactChunkForAi(c).text))).toBe(false);
  });
});
