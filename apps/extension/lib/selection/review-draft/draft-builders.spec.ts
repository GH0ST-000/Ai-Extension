import { describe, expect, it } from 'vitest';
import type { PRReviewFinding, PRReviewReport } from '@project-x/types';

import {
  buildAggregatedReviewBody,
  createReviewDraftFromReport,
  findingToDraftComment,
} from './draft-builders';
import {
  createClientRequestId,
  createReviewSubmissionSnapshot,
  validateReviewDraft,
} from './snapshot';

const report: PRReviewReport = {
  repository: { owner: 'acme', name: 'app' },
  pullRequest: { number: 42, title: 'Add auth' },
  riskLevel: 'medium',
  overview: 'Overall the change looks reasonable.',
  stats: {
    analyzedFiles: 2,
    skippedFiles: 0,
    findings: 1,
    critical: 0,
    high: 0,
    medium: 1,
    low: 0,
    suggestions: 0,
  },
  findings: [],
};

const finding: PRReviewFinding = {
  id: 'f1',
  index: 1,
  severity: 'medium',
  filePath: 'src/auth.ts',
  title: 'Missing null check',
  why: 'user can be undefined',
  raw: '### Finding\nMissing null check',
};

describe('review draft builders', () => {
  it('defaults event to COMMENT and binds destination', () => {
    const draft = createReviewDraftFromReport(report);
    expect(draft.event).toBe('COMMENT');
    expect(draft.destination).toEqual({
      owner: 'acme',
      repository: 'app',
      pullRequestNumber: 42,
    });
    expect(draft.body).toContain('reasonable');
  });

  it('builds PR-level finding comments without inventing line positions', () => {
    const comment = findingToDraftComment(finding);
    expect(comment.mode).toBe('pr');
    expect(comment.positionStatus).toBe('unavailable');
    expect(comment.position).toBeUndefined();
    expect(comment.body).toContain('Missing null check');
  });

  it('aggregates PR-level notes deterministically', () => {
    const body = buildAggregatedReviewBody('Overview', [
      { filePath: 'a.ts', body: 'Fix A' },
      { body: 'General note' },
    ]);
    expect(body).toContain('### Additional review notes');
    expect(body).toContain('`a.ts`: Fix A');
    expect(body).toContain('_general_: General note');
  });
});

describe('review snapshot', () => {
  it('rejects empty COMMENT drafts', () => {
    const draft = createReviewDraftFromReport({
      ...report,
      overview: '',
    });
    expect(validateReviewDraft(draft).ok).toBe(false);
  });

  it('creates an immutable snapshot whose payload matches preview fields', async () => {
    const draft = createReviewDraftFromReport(report);
    draft.comments = [findingToDraftComment(finding)];
    const snapshot = await createReviewSubmissionSnapshot(draft, createClientRequestId());
    expect(snapshot.event).toBe('COMMENT');
    expect(snapshot.owner).toBe('acme');
    expect(snapshot.body).toContain('Additional review notes');
    expect(snapshot.comments).toEqual([]);
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('invalidates by producing a new fingerprint when body changes', async () => {
    const draft = createReviewDraftFromReport(report);
    const a = await createReviewSubmissionSnapshot(draft, 'id-1');
    draft.body = 'Changed overview';
    const b = await createReviewSubmissionSnapshot(draft, 'id-1');
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
