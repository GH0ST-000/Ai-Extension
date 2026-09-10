import { describe, expect, it } from 'vitest';
import type {
  CICheckFailureEvidence,
  CIFailureAnalysis,
  CINormalizedCheck,
} from '@project-x/types';

import { buildCIFailureSignature, compareFailureSignatures } from './failure-signature';
import { normalizeRepositoryPath } from './normalize-path';
import { resolveCIFixTargets, selectPrimaryCIFixTarget } from './resolve-targets';
import { matchCheckOnNewHead, verifyCIFixAgainstSummary } from './verify-fix';

const analysisBase: CIFailureAnalysis = {
  summary: 's',
  likelyRootCause: 'double charge',
  confidence: 'high',
  relatedToPullRequest: 'likely',
  evidence: [],
  affectedFiles: [{ path: 'src/payment.service.ts', verified: true, startLine: 88 }],
  suggestedNextSteps: ['Add idempotency'],
  canSuggestFix: true,
  evidenceTruncated: false,
  owner: 'acme',
  repository: 'pay',
  pullRequestNumber: 142,
  headSha: 'abc1234',
  checkId: 'check_run:1',
  analyzedAt: new Date().toISOString(),
};

function evidence(partial?: Partial<CICheckFailureEvidence>): CICheckFailureEvidence {
  return {
    owner: 'acme',
    repository: 'pay',
    pullRequestNumber: 142,
    headSha: 'abc1234',
    check: {
      id: 'check_run:1',
      name: 'unit-tests',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      canInspectDetails: true,
      evidenceCapabilities: ['ANNOTATIONS'],
    },
    annotations: [
      {
        path: 'src/payment.service.ts',
        startLine: 88,
        message: 'Expected charge() once',
        annotationLevel: 'failure',
      },
    ],
    evidence: [],
    truncated: false,
    redacted: false,
    fetchedAt: new Date().toISOString(),
    ...partial,
  };
}

describe('normalizeRepositoryPath', () => {
  it('rejects traversal', () => {
    expect(normalizeRepositoryPath('../secret')).toBeNull();
    expect(normalizeRepositoryPath('src/payment.service.ts')).toBe('src/payment.service.ts');
  });
});

describe('resolveCIFixTargets', () => {
  it('ranks annotation targets as trusted', () => {
    const targets = resolveCIFixTargets({
      analysis: analysisBase,
      evidence: evidence(),
      changedFilePaths: ['src/payment.service.ts'],
    });
    expect(targets[0]?.filePath).toBe('src/payment.service.ts');
    expect(targets[0]?.trust).toBe('trusted');
    expect(targets[0]?.verified).toBe(true);
  });

  it('keeps AI-only paths suggested until correlated', () => {
    const targets = resolveCIFixTargets({
      analysis: {
        ...analysisBase,
        affectedFiles: [{ path: 'src/other.ts', verified: false }],
      },
      evidence: evidence({ annotations: [] }),
      changedFilePaths: [],
    });
    expect(targets.some((t) => t.filePath === 'src/other.ts' && t.trust === 'suggested')).toBe(
      true,
    );
  });

  it('rejects invalid AI paths', () => {
    const targets = resolveCIFixTargets({
      analysis: {
        ...analysisBase,
        affectedFiles: [{ path: '../../etc/passwd', verified: false }],
      },
      evidence: evidence({ annotations: [] }),
    });
    expect(targets.every((t) => !t.filePath.includes('..'))).toBe(true);
  });

  it('detects ambiguous vs single primary target', () => {
    const single = selectPrimaryCIFixTarget(
      resolveCIFixTargets({ analysis: analysisBase, evidence: evidence() }),
    );
    expect(single.selected?.filePath).toBe('src/payment.service.ts');
    expect(single.ambiguous).toBe(false);

    const multi = selectPrimaryCIFixTarget(
      resolveCIFixTargets({
        evidence: evidence({
          annotations: [
            {
              path: 'src/a.ts',
              message: 'fail a',
              annotationLevel: 'failure',
            },
            {
              path: 'src/b.ts',
              message: 'fail b',
              annotationLevel: 'failure',
            },
          ],
        }),
      }),
    );
    expect(multi.ambiguous).toBe(true);
  });
});

describe('failure signature', () => {
  it('is stable for same annotation evidence', () => {
    const a = buildCIFailureSignature({
      checkName: 'unit-tests',
      evidence: evidence(),
      analysis: analysisBase,
    });
    const b = buildCIFailureSignature({
      checkName: 'unit-tests',
      evidence: evidence(),
      analysis: analysisBase,
    });
    expect(a).toBe(b);
    expect(compareFailureSignatures(a, b)).toBe('same');
  });

  it('detects different failure evidence', () => {
    const prev = buildCIFailureSignature({
      checkName: 'unit-tests',
      evidence: evidence(),
    });
    const next = buildCIFailureSignature({
      checkName: 'unit-tests',
      evidence: evidence({
        annotations: [
          {
            path: 'src/other.ts',
            startLine: 1,
            message: 'Type error TS2345',
            annotationLevel: 'failure',
          },
        ],
      }),
    });
    expect(compareFailureSignatures(prev, next)).toBe('different');
  });
});

describe('verifyCIFixAgainstSummary', () => {
  function check(
    partial: Partial<CINormalizedCheck> & Pick<CINormalizedCheck, 'id' | 'name'>,
  ): CINormalizedCheck {
    return {
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      canInspectDetails: false,
      evidenceCapabilities: ['STATUS_ONLY'],
      ...partial,
    };
  }

  it('marks PASSED for matching check success on new head', () => {
    const verification = verifyCIFixAgainstSummary({
      originalCheckId: 'check_run:1',
      originalCheckName: 'unit-tests',
      originalHeadSha: 'old',
      newHeadSha: 'new',
      summary: {
        owner: 'acme',
        repository: 'pay',
        pullRequestNumber: 1,
        headSha: 'new',
        overallStatus: 'SUCCESS',
        counts: {
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          cancelled: 0,
          neutral: 0,
          skipped: 0,
        },
        checks: [check({ id: 'check_run:99', name: 'unit-tests', conclusion: 'SUCCESS' })],
        fetchedAt: new Date().toISOString(),
      },
    });
    expect(verification.status).toBe('PASSED');
    expect(verification.matchedCheckName).toBe('unit-tests');
  });

  it('does not claim whole PR healthy when other checks fail', () => {
    const verification = verifyCIFixAgainstSummary({
      originalCheckId: 'check_run:1',
      originalCheckName: 'unit-tests',
      originalHeadSha: 'old',
      newHeadSha: 'new',
      summary: {
        owner: 'acme',
        repository: 'pay',
        pullRequestNumber: 1,
        headSha: 'new',
        overallStatus: 'FAILURE',
        counts: {
          total: 2,
          passed: 1,
          failed: 1,
          pending: 0,
          cancelled: 0,
          neutral: 0,
          skipped: 0,
        },
        checks: [
          check({ id: 'check_run:2', name: 'unit-tests', conclusion: 'SUCCESS' }),
          check({ id: 'check_run:3', name: 'lint', conclusion: 'FAILURE' }),
        ],
        fetchedAt: new Date().toISOString(),
      },
    });
    expect(verification.status).toBe('PASSED');
    expect(verification.otherChecksFailing).toBe(true);
  });

  it('returns PENDING when check missing and CI still running', () => {
    const verification = verifyCIFixAgainstSummary({
      originalCheckId: 'check_run:1',
      originalCheckName: 'unit-tests',
      originalHeadSha: 'old',
      newHeadSha: 'new',
      summary: {
        owner: 'acme',
        repository: 'pay',
        pullRequestNumber: 1,
        headSha: 'new',
        overallStatus: 'PENDING',
        counts: {
          total: 0,
          passed: 0,
          failed: 0,
          pending: 0,
          cancelled: 0,
          neutral: 0,
          skipped: 0,
        },
        checks: [],
        fetchedAt: new Date().toISOString(),
      },
    });
    expect(verification.status).toBe('PENDING');
  });

  it('matches by exact name when ids differ across heads', () => {
    expect(
      matchCheckOnNewHead(
        {
          owner: 'a',
          repository: 'b',
          pullRequestNumber: 1,
          headSha: 'n',
          overallStatus: 'PENDING',
          counts: {
            total: 1,
            passed: 0,
            failed: 0,
            pending: 1,
            cancelled: 0,
            neutral: 0,
            skipped: 0,
          },
          checks: [
            check({
              id: 'check_run:9',
              name: 'unit-tests',
              status: 'IN_PROGRESS',
              conclusion: null,
            }),
          ],
          fetchedAt: new Date().toISOString(),
        },
        { id: 'check_run:1', name: 'unit-tests' },
      )?.id,
    ).toBe('check_run:9');
  });

  it('distinguishes STILL_FAILING vs DIFFERENT_FAILURE', () => {
    const prev = buildCIFailureSignature({
      checkName: 'unit-tests',
      evidence: evidence(),
    });
    const same = verifyCIFixAgainstSummary({
      originalCheckId: 'check_run:1',
      originalCheckName: 'unit-tests',
      originalHeadSha: 'old',
      newHeadSha: 'new',
      previousFailureSignature: prev,
      currentFailureSignature: prev,
      summary: {
        owner: 'acme',
        repository: 'pay',
        pullRequestNumber: 1,
        headSha: 'new',
        overallStatus: 'FAILURE',
        counts: {
          total: 1,
          passed: 0,
          failed: 1,
          pending: 0,
          cancelled: 0,
          neutral: 0,
          skipped: 0,
        },
        checks: [check({ id: 'x', name: 'unit-tests', conclusion: 'FAILURE' })],
        fetchedAt: new Date().toISOString(),
      },
    });
    expect(same.status).toBe('STILL_FAILING');

    const differentSig = buildCIFailureSignature({
      checkName: 'unit-tests',
      evidence: evidence({
        annotations: [
          {
            path: 'src/z.ts',
            message: 'completely different error',
            annotationLevel: 'failure',
          },
        ],
      }),
    });
    const diff = verifyCIFixAgainstSummary({
      originalCheckId: 'check_run:1',
      originalCheckName: 'unit-tests',
      originalHeadSha: 'old',
      newHeadSha: 'new',
      previousFailureSignature: prev,
      currentFailureSignature: differentSig,
      summary: {
        owner: 'acme',
        repository: 'pay',
        pullRequestNumber: 1,
        headSha: 'new',
        overallStatus: 'FAILURE',
        counts: {
          total: 1,
          passed: 0,
          failed: 1,
          pending: 0,
          cancelled: 0,
          neutral: 0,
          skipped: 0,
        },
        checks: [check({ id: 'x', name: 'unit-tests', conclusion: 'FAILURE' })],
        fetchedAt: new Date().toISOString(),
      },
    });
    expect(diff.status).toBe('DIFFERENT_FAILURE');
  });
});
