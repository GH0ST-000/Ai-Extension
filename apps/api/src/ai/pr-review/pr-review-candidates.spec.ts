import { describe, expect, it } from 'vitest';

import {
  classifyTestCode,
  contentWords,
  detectMemoryEcho,
  fullTextOfAddedFile,
  memoryRulesFromBlock,
} from './pr-review-candidates';

describe('Gate B — test code classification (content decides, never the path alone)', () => {
  const SPEC = [
    "import { describe, expect, it } from 'vitest';",
    "describe('payments', () => {",
    "  it('works', () => expect(1).toBe(1));",
    '});',
  ].join('\n');

  it('a test entry file (runs tests at the top level, exports nothing) is test_entry', () => {
    expect(classifyTestCode('src/payments.spec.ts', SPEC)).toBe('test_entry');
  });

  it('describe.each / it.only / test.skip forms count as running tests', () => {
    const t = [
      "import { describe, it } from 'vitest';",
      "describe.each([1, 2])('n=%i', (n) => { it.only('x', () => {}); });",
      "test.skip('later', () => {});",
    ].join('\n');
    expect(classifyTestCode('src/x.test.ts', t)).toBe('test_entry');
  });

  it('a test file that also exports a helper may be imported: test_support, not rejected', () => {
    expect(
      classifyTestCode(
        'src/payments.spec.ts',
        `${SPEC}\nexport function makeOrder() { return {}; }`,
      ),
    ).toBe('test_support');
  });

  it('a helper or fixture in a test directory (no test cases) is test_support', () => {
    const helper =
      'export function tenantFixture(id: string) {\n  return { id, workspaceId: id };\n}';
    expect(classifyTestCode('apps/api/test/helpers/tenant-fixture.ts', helper)).toBe(
      'test_support',
    );
    expect(classifyTestCode('src/fixtures/rows.ts', helper)).toBe('test_support');
  });

  it('CommonJS exports also count as importable', () => {
    expect(classifyTestCode('src/a.spec.js', `${SPEC}\nmodule.exports = { helper: 1 };`)).toBe(
      'test_support',
    );
  });

  it('a test-runner file outside test paths is recognised by its framework import', () => {
    expect(classifyTestCode('src/payments.check.ts', SPEC)).toBe('test_entry');
  });

  it('production code is not test code — even with describe-like calls and no exports', () => {
    const script = "describe('not a test runner here');\nrunMigration();";
    expect(classifyTestCode('scripts/migrate.ts', script)).toBe('not_test');
    expect(classifyTestCode('src/service.ts', 'export class S {}')).toBe('not_test');
  });

  it('full text is rebuilt only for files the PR adds completely', () => {
    const added = [
      { kind: '+' as const, text: 'a', oldLine: null, newLine: 1 },
      { kind: '+' as const, text: 'b', oldLine: null, newLine: 2 },
    ];
    expect(fullTextOfAddedFile(added)).toBe('a\nb');
    expect(fullTextOfAddedFile([added[1]!])).toBeNull(); // line 1 missing
    expect(
      fullTextOfAddedFile([{ kind: ' ', text: 'a', oldLine: 1, newLine: 1 }, added[1]!]),
    ).toBeNull(); // modified file
  });
});

describe('Gate C — Project Memory echo (flag only)', () => {
  const BLOCK = [
    '<<PROJECT_MEMORY source="server" version="v1">>',
    'Rules saved by this workspace for this repository. Apply them as project context.',
    '- [high] (USER_PREFERENCE) payment-idempotency: All payment webhook handlers must be idempotent. Duplicate webhook events must never cause duplicate billing operations.',
    '- [medium] (CODE_CONVENTION) eslint: ESLint is present.',
    '<</PROJECT_MEMORY>>',
  ].join('\n');

  it('extracts rule texts from the server-built block', () => {
    const rules = memoryRulesFromBlock(BLOCK);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toContain('duplicate billing');
  });

  it('flags a claim repeating rule phrases that the changed code does not contain (live #5)', () => {
    const claim =
      'Ensuring Idempotence for Payment Webhook Handlers\nPayment webhook handlers must be idempotent to avoid duplicate billing which could lead to financial discrepancies.\nDuplicate payment webhook event';
    // The changed test even contains the rule's first sentence — but not "duplicate billing".
    const code =
      "const PAYMENT_RULE = 'All payment webhook handlers must be idempotent.';\nconst rule = await memory.createRule('owner-1', 'acme', 'payments', {";
    expect(detectMemoryEcho(claim, memoryRulesFromBlock(BLOCK), code)).toMatchObject({
      rule: 0,
      ungrounded: expect.any(Number),
    });
  });

  it('no flag when every repeated phrase is in the changed code (memory-guided, code-grounded)', () => {
    const claim = 'The payment webhook handler processes duplicate billing events twice.';
    const code =
      'export async function paymentWebhookHandler(event) {\n  // duplicate billing guard missing\n  await charge(event);\n}';
    expect(detectMemoryEcho(claim, memoryRulesFromBlock(BLOCK), code)).toBeNull();
  });

  it('no flag for a single shared phrase or without applied rules', () => {
    expect(
      detectMemoryEcho('Webhook handlers retry forever.', memoryRulesFromBlock(BLOCK), ''),
    ).toBeNull();
    expect(detectMemoryEcho('duplicate billing duplicate billing', [], '')).toBeNull();
  });

  it('code and prose compare after camelCase / snake_case splitting', () => {
    expect(contentWords('paymentWebhookHandlers duplicate_billing')).toEqual([
      'payment',
      'webhook',
      'handler',
      'duplicate',
      'billing',
    ]);
  });
});
