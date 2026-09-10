import { describe, expect, it } from 'vitest';

import { buildCiSuggestFixCustomPrompt } from './build-ci-suggest-context';
import { useCIFixSessionStore } from './ci-fix.store';
import type { CIFailureAnalysis, CINormalizedCheck } from '@project-x/types';

const check: CINormalizedCheck = {
  id: 'check_run:1',
  name: 'unit-tests',
  status: 'COMPLETED',
  conclusion: 'FAILURE',
  canInspectDetails: true,
  evidenceCapabilities: ['ANNOTATIONS'],
};

const analysis: CIFailureAnalysis = {
  summary: 's',
  likelyRootCause: 'double charge',
  confidence: 'high',
  relatedToPullRequest: 'likely',
  evidence: [],
  affectedFiles: [{ path: 'src/a.ts', verified: true }],
  suggestedNextSteps: ['idempotency'],
  canSuggestFix: true,
  evidenceTruncated: false,
  owner: 'acme',
  repository: 'pay',
  pullRequestNumber: 1,
  headSha: 'abc1234ffff',
  checkId: 'check_run:1',
  analyzedAt: new Date().toISOString(),
};

describe('CI Fix Session store', () => {
  it('binds to source check/head and becomes stale on PR change', () => {
    useCIFixSessionStore.getState().clear();
    useCIFixSessionStore.getState().startFromCheck({
      owner: 'acme',
      repository: 'pay',
      pullRequestNumber: 1,
      sourceHeadSha: 'abc1234ffff',
      sourceCheck: check,
    });
    const session = useCIFixSessionStore.getState().session;
    expect(session?.status).toBe('ANALYZING');
    expect(session?.sourceCheck.id).toBe('check_run:1');

    const ok = useCIFixSessionStore.getState().assertBinding({
      owner: 'acme',
      repository: 'pay',
      pullRequestNumber: 2,
    });
    expect(ok).toBe(false);
    expect(useCIFixSessionStore.getState().session?.status).toBe('STALE');
  });

  it('transitions to WAITING_FOR_NEW_CI after commit without claiming verified', () => {
    useCIFixSessionStore.getState().clear();
    useCIFixSessionStore.getState().startFromCheck({
      owner: 'acme',
      repository: 'pay',
      pullRequestNumber: 1,
      sourceHeadSha: 'abc1234ffff',
      sourceCheck: check,
    });
    useCIFixSessionStore.setState({
      session: {
        ...useCIFixSessionStore.getState().session!,
        status: 'APPLYING',
        selectedTarget: {
          filePath: 'src/a.ts',
          source: 'annotation',
          trust: 'trusted',
          verified: true,
        },
        analysis,
      },
    });
    useCIFixSessionStore.getState().recordCommit({
      sha: 'def5678aaaa',
      previousHeadSha: 'abc1234ffff',
    });
    const session = useCIFixSessionStore.getState().session;
    expect(session?.status).toBe('WAITING_FOR_NEW_CI');
    expect(session?.verification).toBeUndefined();
    expect(session?.currentHeadSha).toBe('def5678aaaa');
  });

  it('does not record commit when previous head mismatches', () => {
    useCIFixSessionStore.getState().clear();
    useCIFixSessionStore.getState().startFromCheck({
      owner: 'acme',
      repository: 'pay',
      pullRequestNumber: 1,
      sourceHeadSha: 'abc1234ffff',
      sourceCheck: check,
    });
    useCIFixSessionStore.getState().recordCommit({
      sha: 'def5678aaaa',
      previousHeadSha: 'otherhead',
    });
    expect(useCIFixSessionStore.getState().session?.status).toBe('STALE');
  });
});

describe('buildCiSuggestFixCustomPrompt', () => {
  it('includes CI constraints and does not claim verified fix', () => {
    const prompt = buildCiSuggestFixCustomPrompt({
      checkName: 'unit-tests',
      headSha: 'abc1234ffff',
      analysis,
      target: {
        filePath: 'src/a.ts',
        source: 'annotation',
        trust: 'trusted',
        verified: true,
      },
    });
    expect(prompt).toContain('CI_FIX_CONTEXT');
    expect(prompt).toContain('suggested change');
    expect(prompt).toContain('eslint-disable');
  });
});
