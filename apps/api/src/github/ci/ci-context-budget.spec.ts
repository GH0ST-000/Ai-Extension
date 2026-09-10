import { describe, expect, it } from 'vitest';
import type { CINormalizedCheck } from '@project-x/types';

import { buildCIFailureAnalysisContext, extractRelevantLogExcerpt } from './ci-context-budget';
import { parseCIFailureAnalysisJson } from './ci-analysis-parse';

const check: CINormalizedCheck = {
  id: 'check_run:1',
  name: 'unit-tests',
  status: 'COMPLETED',
  conclusion: 'FAILURE',
  canInspectDetails: true,
  evidenceCapabilities: ['ANNOTATIONS'],
};

describe('ci-context-budget', () => {
  it('prioritizes failure lines in log excerpts', () => {
    const log = [
      'npm notice',
      'Downloading packages…',
      'Expected charge() to be called once',
      'Received: 2 calls',
      '=======',
    ].join('\n');
    const { text } = extractRelevantLogExcerpt(log, 500);
    expect(text).toContain('Expected charge()');
    expect(text).not.toContain('npm notice');
  });

  it('builds analysis context with truncation metadata', () => {
    const ctx = buildCIFailureAnalysisContext({
      owner: 'acme',
      repository: 'payments',
      pullRequestNumber: 142,
      headSha: 'abcdef0123456789',
      check,
      annotations: [
        {
          path: 'src/payment.service.ts',
          startLine: 88,
          message: 'Expected 1 call',
          annotationLevel: 'failure',
        },
      ],
      changedFiles: [{ path: 'src/payment.service.ts' }],
      summaryText: 'Tests failed',
    });
    expect(ctx.promptText).toContain('UNTRUSTED');
    expect(ctx.promptText).toContain('src/payment.service.ts');
    expect(ctx.changedFilePaths).toContain('src/payment.service.ts');
    expect(ctx.evidence.some((e) => e.source === 'annotation')).toBe(true);
  });
});

describe('ci-analysis-parse', () => {
  it('parses structured JSON and validates affected paths', () => {
    const analysis = parseCIFailureAnalysisJson(
      JSON.stringify({
        summary: 'Retry double-charge',
        likelyRootCause: 'charge() called twice',
        confidence: 'high',
        relatedToPullRequest: 'likely',
        affectedFiles: [
          { path: 'src/payment.service.ts', reason: 'annotation' },
          { path: '../../secret', reason: 'bad' },
          { path: 'not-in-pr.ts', reason: 'hallucinated' },
        ],
        suggestedNextSteps: ['Add idempotency'],
        canSuggestFix: true,
      }),
      {
        owner: 'acme',
        repository: 'payments',
        pullRequestNumber: 142,
        headSha: 'abc',
        checkId: 'check_run:1',
        evidence: [],
        evidenceTruncated: false,
        trustedChangedPaths: ['src/payment.service.ts'],
      },
    );

    expect(analysis.canSuggestFix).toBe(true);
    expect(analysis.affectedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/payment.service.ts', verified: true }),
        expect.objectContaining({ path: 'not-in-pr.ts', verified: false }),
      ]),
    );
    expect(analysis.affectedFiles.every((f) => !f.path.includes('..'))).toBe(true);
  });

  it('rejects invalid AI output', () => {
    expect(() =>
      parseCIFailureAnalysisJson('not json', {
        owner: 'a',
        repository: 'b',
        pullRequestNumber: 1,
        headSha: 'x',
        checkId: 'check_run:1',
        evidence: [],
        evidenceTruncated: false,
        trustedChangedPaths: [],
      }),
    ).toThrow('AI_ANALYSIS_FAILED');
  });

  it('downgrades high confidence when evidence truncated', () => {
    const analysis = parseCIFailureAnalysisJson(
      JSON.stringify({
        summary: 's',
        likelyRootCause: 'r',
        confidence: 'high',
        relatedToPullRequest: 'uncertain',
        canSuggestFix: false,
      }),
      {
        owner: 'a',
        repository: 'b',
        pullRequestNumber: 1,
        headSha: 'x',
        checkId: 'check_run:1',
        evidence: [],
        evidenceTruncated: true,
        trustedChangedPaths: [],
      },
    );
    expect(analysis.confidence).toBe('medium');
    expect(analysis.evidenceTruncated).toBe(true);
  });
});
