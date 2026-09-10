import type { JiraPageType, PageContext, PageContextJira } from '@project-x/types';

import { MAX_TITLE_CHARS, MAX_URL_CHARS } from '../constants';
import type { PageAdapter } from '../page-adapter';
import { truncateText } from '../dom-context';

export type ParsedJiraUrl = {
  siteHost: string;
  pageType: JiraPageType;
  issueKey?: string;
  projectKey?: string;
};

/**
 * Parse Jira Cloud URL shapes. Pure for unit tests.
 * Supports *.atlassian.net browse / issues / boards / backlog / projects.
 */
export function parseJiraCloudUrl(url: URL): ParsedJiraUrl | null {
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('.atlassian.net')) {
    return null;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const base: ParsedJiraUrl = { siteHost: host, pageType: 'unknown' };

  // selectedIssue=PAY-321 query (board issue drawer) — check before board path
  const selected = url.searchParams.get('selectedIssue')?.toUpperCase();
  if (selected && /^[A-Z][A-Z0-9]+-\d+$/.test(selected)) {
    return {
      ...base,
      pageType: 'issue',
      issueKey: selected,
      projectKey: selected.split('-')[0],
    };
  }

  // /browse/PAY-321
  if (parts[0] === 'browse' && parts[1]) {
    const key = parts[1].toUpperCase();
    if (/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
      return {
        ...base,
        pageType: 'issue',
        issueKey: key,
        projectKey: key.split('-')[0],
      };
    }
  }

  // /jira/software/projects/PAY/boards/1
  if (parts.includes('boards')) {
    return { ...base, pageType: 'board', projectKey: extractProjectKey(parts) };
  }
  if (parts.includes('backlog')) {
    return { ...base, pageType: 'backlog', projectKey: extractProjectKey(parts) };
  }

  if (parts[0] === 'issues' || parts.includes('issue')) {
    const maybeKey = parts.find((p) => /^[A-Z][A-Z0-9]+-\d+$/i.test(p));
    if (maybeKey) {
      const key = maybeKey.toUpperCase();
      return {
        ...base,
        pageType: 'issue',
        issueKey: key,
        projectKey: key.split('-')[0],
      };
    }
    return { ...base, pageType: 'search' };
  }

  if (parts[0] === 'jira' && parts[1] === 'software' && parts[2] === 'projects') {
    return { ...base, pageType: 'project', projectKey: parts[3]?.toUpperCase() };
  }

  return base;
}

function extractProjectKey(parts: string[]): string | undefined {
  const idx = parts.indexOf('projects');
  const key = idx >= 0 ? parts[idx + 1] : undefined;
  return key ? key.toUpperCase() : undefined;
}

function readVisibleSummary(): string | undefined {
  const selectors = [
    'h1[data-testid="issue.views.issue-base.foundation.summary.heading"]',
    '[data-testid="issue.views.issue-base.foundation.summary.heading"]',
    '#summary-val',
    'h1',
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const text = el?.textContent?.replace(/\s+/g, ' ').trim();
    if (text && text.length > 2 && text.length < 500) {
      return text;
    }
  }
  return undefined;
}

function readMeta(label: string): string | undefined {
  const nodes = Array.from(document.querySelectorAll('span, div, dt, dd'));
  for (const node of nodes) {
    const text = node.textContent?.replace(/\s+/g, ' ').trim().toLowerCase();
    if (text === label.toLowerCase()) {
      const next = node.nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim();
      if (next && next.length < 80) {
        return next;
      }
    }
  }
  return undefined;
}

export const jiraPageAdapter: PageAdapter = {
  matches(url) {
    return url.hostname.toLowerCase().endsWith('.atlassian.net');
  },

  extract(url): PageContext {
    const parsed = parseJiraCloudUrl(url);
    const jira: PageContextJira = {
      siteHost: parsed?.siteHost ?? url.hostname.toLowerCase(),
      pageType: parsed?.pageType ?? 'unknown',
      issueKey: parsed?.issueKey,
      projectKey: parsed?.projectKey,
    };

    if (jira.pageType === 'issue') {
      jira.summary = readVisibleSummary();
      jira.status = readMeta('Status') ?? undefined;
      jira.priority = readMeta('Priority') ?? undefined;
      jira.issueType = readMeta('Type') ?? readMeta('Issue Type') ?? undefined;
    }

    return {
      type: 'jira',
      url: truncateText(url.toString(), MAX_URL_CHARS),
      title: truncateText(
        document.title || jira.summary || jira.issueKey || 'Jira',
        MAX_TITLE_CHARS,
      ),
      jira,
    };
  },
};
