import { describe, expect, it } from 'vitest';
import { AIAction } from '@project-x/types';

import {
  actionsForTab,
  resolveDefaultAssistantTab,
  TEXT_TAB_ACTIONS,
  GITHUB_TAB_ACTIONS,
  JIRA_TAB_ACTIONS,
  API_TAB_ACTIONS,
} from './assistant-tabs';

describe('assistant tabs', () => {
  it('partitions actions without overlap across tabs', () => {
    const all = [
      ...TEXT_TAB_ACTIONS,
      ...GITHUB_TAB_ACTIONS,
      ...JIRA_TAB_ACTIONS,
      ...API_TAB_ACTIONS,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps verbal actions on Text tab', () => {
    expect(actionsForTab('text').has(AIAction.SUMMARIZE)).toBe(true);
    expect(actionsForTab('text').has(AIAction.EXPLAIN_CODE)).toBe(false);
  });

  it('keeps review actions on GitHub tab', () => {
    expect(actionsForTab('github').has(AIAction.REVIEW_ENTIRE_PR)).toBe(true);
    expect(actionsForTab('github').has(AIAction.EXPLAIN)).toBe(false);
  });

  it('defaults to API on OpenAPI pages', () => {
    expect(resolveDefaultAssistantTab({ pageType: 'openapi', hasOpenApi: true })).toBe('api');
  });

  it('defaults to Jira on issue pages', () => {
    expect(resolveDefaultAssistantTab({ pageType: 'jira', hasJiraIssue: true })).toBe('jira');
  });

  it('defaults to GitHub on PR pages', () => {
    expect(resolveDefaultAssistantTab({ pageType: 'github', hasGithub: true })).toBe('github');
  });

  it('defaults to Text otherwise', () => {
    expect(resolveDefaultAssistantTab({})).toBe('text');
  });

  it('keeps ANALYZE_ENGINEERING_ALIGNMENT out of all tab catalogs (banner-only)', () => {
    expect(TEXT_TAB_ACTIONS.has(AIAction.ANALYZE_ENGINEERING_ALIGNMENT)).toBe(false);
    expect(GITHUB_TAB_ACTIONS.has(AIAction.ANALYZE_ENGINEERING_ALIGNMENT)).toBe(false);
    expect(JIRA_TAB_ACTIONS.has(AIAction.ANALYZE_ENGINEERING_ALIGNMENT)).toBe(false);
    expect(API_TAB_ACTIONS.has(AIAction.ANALYZE_ENGINEERING_ALIGNMENT)).toBe(false);
  });

  it('keeps PLAN_DEVELOPER_WORKFLOW out of catalogs (Flow tab panel owns UX)', () => {
    expect(TEXT_TAB_ACTIONS.has(AIAction.PLAN_DEVELOPER_WORKFLOW)).toBe(false);
    expect(GITHUB_TAB_ACTIONS.has(AIAction.PLAN_DEVELOPER_WORKFLOW)).toBe(false);
    expect(JIRA_TAB_ACTIONS.has(AIAction.PLAN_DEVELOPER_WORKFLOW)).toBe(false);
    expect(API_TAB_ACTIONS.has(AIAction.PLAN_DEVELOPER_WORKFLOW)).toBe(false);
    expect(actionsForTab('workflow').size).toBe(0);
  });
});
