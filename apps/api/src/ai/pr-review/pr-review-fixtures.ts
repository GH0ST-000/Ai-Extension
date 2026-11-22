/** Deterministic diff fixtures shared by PR review specs (test-only helpers). */
import type { ChangedFile } from './pr-review-files';

/** A unified-diff patch of `lines` added lines starting at `start`, ~`width` chars per line. */
export function makePatch(
  lines: number,
  opts: { start?: number; width?: number; tag?: string } = {},
) {
  const start = opts.start ?? 1;
  const width = opts.width ?? 40;
  const tag = opts.tag ?? 'x';
  const body = Array.from({ length: lines }, (_, i) => {
    const text = `const ${tag}${start + i} = compute('${tag}', ${start + i});`;
    return `+${text.padEnd(width, ' ')}`;
  });
  return [`@@ -${start},0 +${start},${lines} @@`, ...body].join('\n');
}

export function makeFile(
  path: string,
  patch: string | null,
  extra: Partial<ChangedFile> = {},
): ChangedFile {
  return {
    path,
    status: 'modified',
    changes: patch ? patch.split('\n').length - 1 : 0,
    patch,
    ...extra,
  };
}

/**
 * The QA PR that the old single-call budget cut to 25 of 61 files: 58 source/test/doc files
 * with ~2.4k-char diffs (alphabetical GitHub order puts docs and tests before security code),
 * plus a lockfile, an image and one file GitHub sent without a patch.
 */
export function sixtyOneFilePr(): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (let i = 0; i < 20; i += 1)
    files.push(makeFile(`docs/guide-${i}.md`, makePatch(57, { tag: `d${i}_` })));
  for (let i = 0; i < 18; i += 1)
    files.push(makeFile(`apps/web/src/component-${i}.spec.tsx`, makePatch(57, { tag: `t${i}_` })));
  for (let i = 0; i < 15; i += 1)
    files.push(makeFile(`apps/web/src/component-${i}.tsx`, makePatch(57, { tag: `c${i}_` })));
  for (let i = 0; i < 5; i += 1)
    files.push(makeFile(`apps/api/src/auth/session-${i}.ts`, makePatch(57, { tag: `s${i}_` })));
  files.push(makeFile('pnpm-lock.yaml', makePatch(400, { tag: 'lock' })));
  files.push(makeFile('assets/logo.png', null, { status: 'added', changes: 0 }));
  files.push(makeFile('apps/api/src/billing/reconcile.ts', null, { changes: 12_000 }));
  return files;
}

/** A complete, well-supported raw model finding (override any field). */
export function rawFinding(
  over: Partial<import('./pr-review-findings').BatchFindingInput> = {},
): import('./pr-review-findings').BatchFindingInput {
  return {
    path: 'src/a.ts',
    lineStart: null,
    lineEnd: null,
    category: 'security',
    severity: 'high',
    confidence: 'high',
    title: 'Memory list ignores workspace scope',
    explanation: 'The query reads rows from every workspace.',
    evidence: '',
    trigger: 'A member of workspace B calls GET /memory for repo acme/app',
    failurePath:
      'list() at src/a.ts:12 queries without workspaceId and returns all rows to the caller',
    violatedInvariant: 'Memory rows are only readable inside their own workspace',
    impact: 'Rules of workspace A are disclosed to workspace B',
    assumptions: '',
    missingContext: '',
    changeType: 'introduced',
    ...over,
  };
}

/** A validated finding with sensible defaults (for merge / risk / render tests). */
export function validatedFinding(
  over: Partial<import('./pr-review-findings').ValidatedFinding> = {},
): import('./pr-review-findings').ValidatedFinding {
  return {
    stableId: '',
    path: 'src/a.ts',
    lineStart: 105,
    lineEnd: 105,
    claimedLines: null,
    category: 'correctness',
    requestedSeverity: 'medium',
    severity: 'medium',
    confidence: 'high',
    title: 'Unchecked result',
    explanation: 'The value is used without validation.',
    evidence: "const v105 = compute('v', 105);",
    evidenceKind: 'changed',
    changeType: 'introduced',
    headLine: 105,
    trigger: 'compute returns undefined for unknown keys',
    failurePath: 'a.ts:105 passes undefined to save() which throws',
    violatedInvariant: 'save receives a defined value',
    impact: 'Request fails with 500',
    assumptions: '',
    missingContext: '',
    gateNotes: [],
    verification: { status: 'confirmed' },
    disposition: 'reported',
    alsoIn: [],
    batchId: 'b1',
    ordinal: 0,
    ...over,
  };
}

/** UsageService stand-in for tests: reservations always granted, committed or released. */
export function usageStub() {
  return {
    consume: async () => ({ allowed: true }),
    reserve: async (i: { workspaceId: string; metric: string; operationId: string }) => ({
      workspaceId: i.workspaceId,
      metric: i.metric,
      idempotencyKey: `op:${i.operationId}`,
      operationId: i.operationId,
      quantity: 1,
    }),
    commit: async () => true,
    renewLease: async () => true,
    startHeartbeat: () => () => undefined,
    markDelivered: async () => true,
    findReplay: async () => null,
    releaseReservation: async () => true,
    release: async () => true,
    /**
     * F-06 / F-07: provider work already ran. Like UsageService within the daily refund
     * budget: the reservation is released through `releaseReservation`.
     */
    async settleAfterProviderWork(
      this: { releaseReservation: (reservation: unknown) => Promise<boolean> },
      reservation: unknown,
      _userId: string,
    ): Promise<'refunded' | 'charged' | 'missing'> {
      await this.releaseReservation(reservation);
      return 'refunded';
    },
  };
}
