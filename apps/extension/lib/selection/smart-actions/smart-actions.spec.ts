import { describe, expect, it } from 'vitest';
import { AIAction } from '@project-x/types';

import { AI_ACTIONS } from '../constants';
import { classifyContent } from './classify-content';
import { getRankedActions, rankActions, RANKINGS } from './rank-actions';

describe('classifyContent', () => {
  it('detects code snippets', () => {
    const text = [
      'export function greet(name: string) {',
      '  const message = `Hello ${name}`;',
      '  return message;',
      '}',
    ].join('\n');

    expect(classifyContent(text)).toBe('code');
  });

  it('detects errors and stack traces', () => {
    const text = [
      "Uncaught TypeError: Cannot read properties of undefined (reading 'startsWith')",
      '    at DashboardNav (dashboard-nav.tsx:17:48)',
      '    at renderWithHooks (react-dom.js:1:1)',
    ].join('\n');

    expect(classifyContent(text)).toBe('error');
  });

  it('detects short phrases', () => {
    expect(classifyContent('ship it')).toBe('short-text');
    expect(classifyContent('primary CTA label')).toBe('short-text');
  });

  it('detects prose paragraphs', () => {
    const text =
      'Project X helps you understand the page you are reading. Highlight any passage and ask for a summary without leaving the tab.';
    expect(classifyContent(text)).toBe('prose');
  });

  it('detects structured JSON-like data', () => {
    expect(classifyContent('{"status":"ok","redis":"up"}')).toBe('structured-data');
  });

  it('uses selection-in-code hint', () => {
    expect(classifyContent('index', { selectionInCodeElement: true })).toBe('code');
  });
});

describe('rankActions', () => {
  it('keeps every action for each content type', () => {
    for (const contentType of Object.keys(RANKINGS) as Array<keyof typeof RANKINGS>) {
      const ranked = rankActions(contentType);
      expect(ranked.map((action) => action.id).sort()).toEqual(
        AI_ACTIONS.map((action) => action.id).sort(),
      );
    }
  });

  it('ranks code selections with Explain Code first', () => {
    expect(rankActions('code').map((action) => action.id)).toEqual([
      AIAction.EXPLAIN_CODE,
      AIAction.REVIEW_CODE,
      AIAction.SUGGEST_FIX,
      AIAction.REVIEW_ENTIRE_PR,
      AIAction.EXPLAIN,
      AIAction.CUSTOM,
      AIAction.SUMMARIZE,
      AIAction.TRANSLATE,
      AIAction.IMPROVE_WRITING,
    ]);
  });

  it('ranks prose with Summarize first', () => {
    expect(rankActions('prose').map((action) => action.id)).toEqual([
      AIAction.SUMMARIZE,
      AIAction.EXPLAIN,
      AIAction.IMPROVE_WRITING,
      AIAction.TRANSLATE,
      AIAction.CUSTOM,
      AIAction.REVIEW_CODE,
      AIAction.REVIEW_ENTIRE_PR,
      AIAction.SUGGEST_FIX,
      AIAction.EXPLAIN_CODE,
    ]);
  });

  it('ranks short text with Explain first', () => {
    expect(rankActions('short-text').map((action) => action.id)).toEqual([
      AIAction.EXPLAIN,
      AIAction.IMPROVE_WRITING,
      AIAction.TRANSLATE,
      AIAction.CUSTOM,
      AIAction.SUMMARIZE,
      AIAction.REVIEW_CODE,
      AIAction.REVIEW_ENTIRE_PR,
      AIAction.SUGGEST_FIX,
      AIAction.EXPLAIN_CODE,
    ]);
  });

  it('ranks errors with Explain then Explain Code', () => {
    expect(rankActions('error').map((action) => action.id)).toEqual([
      AIAction.EXPLAIN,
      AIAction.EXPLAIN_CODE,
      AIAction.REVIEW_CODE,
      AIAction.SUGGEST_FIX,
      AIAction.REVIEW_ENTIRE_PR,
      AIAction.CUSTOM,
      AIAction.SUMMARIZE,
      AIAction.TRANSLATE,
      AIAction.IMPROVE_WRITING,
    ]);
  });

  it('promotes Review Entire PR then Code Review on GitHub PR code selections', () => {
    const ranked = rankActions('code', AI_ACTIONS, {
      githubView: 'pr',
      selectionInCodeElement: true,
      pageType: 'github',
      codeHost: true,
    });
    expect(ranked[0]?.id).toBe(AIAction.REVIEW_ENTIRE_PR);
    expect(ranked[1]?.id).toBe(AIAction.REVIEW_CODE);
    expect(ranked[2]?.id).toBe(AIAction.SUGGEST_FIX);
  });
});

describe('getRankedActions', () => {
  it('promotes Explain Code on GitHub code selections', () => {
    const code = 'const total = items.reduce((sum, item) => sum + item.price, 0);';
    const { contentType, actions } = getRankedActions(code, {
      pageType: 'github',
      codeHost: true,
      selectionInCodeElement: true,
    });

    expect(contentType).toBe('code');
    expect(actions[0]?.id).toBe(AIAction.EXPLAIN_CODE);
  });

  it('returns prose ranking for a long paragraph', () => {
    const text =
      'When you select a paragraph on documentation sites, Project X should prefer summarize and explain before code-oriented tools.';
    const { contentType, actions } = getRankedActions(text);
    expect(contentType).toBe('prose');
    expect(actions[0]?.id).toBe(AIAction.SUMMARIZE);
  });
});
