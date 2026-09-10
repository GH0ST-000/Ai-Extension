import { describe, expect, it } from 'vitest';

import { parseJiraCloudUrl } from './adapters/jira.adapter';
import { parseGitHubUrl } from './adapters/github.adapter';

describe('parseJiraCloudUrl', () => {
  it('parses browse issue URLs', () => {
    expect(parseJiraCloudUrl(new URL('https://acme.atlassian.net/browse/PAY-321'))).toEqual({
      siteHost: 'acme.atlassian.net',
      pageType: 'issue',
      issueKey: 'PAY-321',
      projectKey: 'PAY',
    });
  });

  it('parses selectedIssue query on boards', () => {
    expect(
      parseJiraCloudUrl(
        new URL(
          'https://acme.atlassian.net/jira/software/projects/PAY/boards/1?selectedIssue=PAY-9',
        ),
      ),
    ).toMatchObject({
      pageType: 'issue',
      issueKey: 'PAY-9',
      projectKey: 'PAY',
    });
  });

  it('detects board and backlog page types', () => {
    expect(
      parseJiraCloudUrl(new URL('https://acme.atlassian.net/jira/software/projects/PAY/boards/2'))
        ?.pageType,
    ).toBe('board');
    expect(
      parseJiraCloudUrl(new URL('https://acme.atlassian.net/jira/software/projects/PAY/backlog'))
        ?.pageType,
    ).toBe('backlog');
  });

  it('returns null for non-Jira hosts', () => {
    expect(parseJiraCloudUrl(new URL('https://github.com/acme/app'))).toBeNull();
  });
});

describe('GitHub adapter unchanged for Day 17', () => {
  it('still parses PR URLs', () => {
    expect(parseGitHubUrl(new URL('https://github.com/acme/app/pull/42'))).toEqual({
      owner: 'acme',
      repository: 'app',
      isPullRequest: true,
      pullRequestNumber: 42,
    });
  });
});
