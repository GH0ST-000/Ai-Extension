import { describe, expect, it } from 'vitest';

import { detectJiraKeysInPrSignals, findJiraIssueKeysInText } from './jira-key-match';

describe('findJiraIssueKeysInText', () => {
  it('matches keys with word boundaries', () => {
    expect(findJiraIssueKeysInText('PAY-321 in title')).toEqual(['PAY-321']);
  });

  it('rejects bare numbers', () => {
    expect(findJiraIssueKeysInText('ticket 321 only')).toEqual([]);
  });
});

describe('detectJiraKeysInPrSignals', () => {
  it('prefers title/branch over body and records sources', () => {
    const hits = detectJiraKeysInPrSignals({
      title: 'PAY-321 Fix charges',
      body: 'Also see OPS-9',
      headBranch: 'feature/PAY-321-fix',
    });
    expect(hits[0]).toMatchObject({
      issueKey: 'PAY-321',
      source: 'pr-title',
      confidence: 'high',
    });
    expect(hits.some((h) => h.issueKey === 'OPS-9' && h.source === 'pr-body')).toBe(true);
  });

  it('detects branch-only keys', () => {
    expect(
      detectJiraKeysInPrSignals({
        title: 'misc',
        headBranch: 'bugfix/ABC-12',
      }),
    ).toEqual([
      {
        issueKey: 'ABC-12',
        source: 'branch-name',
        confidence: 'high',
      },
    ]);
  });
});
