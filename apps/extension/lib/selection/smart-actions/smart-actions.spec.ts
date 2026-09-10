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

  it('does not treat business prose as an error', () => {
    expect(classifyContent('Our marketing campaign failed to reach the expected audience.')).toBe(
      'prose',
    );
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
    expect(
      rankActions('code')
        .map((action) => action.id)
        .slice(0, 3),
    ).toEqual([AIAction.EXPLAIN_CODE, AIAction.REVIEW_CODE, AIAction.SUGGEST_FIX]);
  });

  it('ranks prose with Summarize first', () => {
    expect(rankActions('prose')[0]?.id).toBe(AIAction.SUMMARIZE);
  });

  it('ranks short text with Explain first', () => {
    expect(rankActions('short-text')[0]?.id).toBe(AIAction.EXPLAIN);
  });

  it('ranks errors with Find Root Cause → Suggest Fix → Understand Error', () => {
    expect(
      rankActions('error')
        .map((action) => action.id)
        .slice(0, 3),
    ).toEqual([AIAction.FIND_ROOT_CAUSE, AIAction.SUGGEST_FIX, AIAction.UNDERSTAND_ERROR]);
  });

  it('ranks network errors with Understand Error first', () => {
    const ranked = rankActions('error', AI_ACTIONS, undefined, {
      isError: true,
      confidence: 0.8,
      category: 'network',
      errorCode: 'ECONNREFUSED',
      signals: ['node-network'],
    });
    expect(ranked.map((action) => action.id).slice(0, 3)).toEqual([
      AIAction.UNDERSTAND_ERROR,
      AIAction.FIND_ROOT_CAUSE,
      AIAction.SUGGEST_FIX,
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

  it('keeps error intelligence ahead of PR review on GitHub PR error selections', () => {
    const ranked = rankActions(
      'error',
      AI_ACTIONS,
      { githubView: 'pr', pageType: 'github', codeHost: true },
      {
        isError: true,
        confidence: 0.9,
        category: 'runtime',
        signals: ['js-runtime'],
      },
    );
    expect(ranked.map((action) => action.id).slice(0, 3)).toEqual([
      AIAction.FIND_ROOT_CAUSE,
      AIAction.SUGGEST_FIX,
      AIAction.UNDERSTAND_ERROR,
    ]);
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

  it('returns prose ranking for a long paragraph without error actions first', () => {
    const text =
      'When you select a paragraph on documentation sites, Project X should prefer summarize and explain before code-oriented tools.';
    const { contentType, actions } = getRankedActions(text);
    expect(contentType).toBe('prose');
    expect(actions[0]?.id).toBe(AIAction.SUMMARIZE);
    expect(actions.slice(0, 4).map((a) => a.id)).not.toContain(AIAction.FIND_ROOT_CAUSE);
  });

  it('promotes error intelligence for TypeError + nearby-code style selection', () => {
    const text = "TypeError: Cannot read properties of undefined (reading 'id')";
    const { contentType, actions } = getRankedActions(text);
    expect(contentType).toBe('error');
    expect(actions.map((a) => a.id).slice(0, 3)).toEqual([
      AIAction.FIND_ROOT_CAUSE,
      AIAction.SUGGEST_FIX,
      AIAction.UNDERSTAND_ERROR,
    ]);
  });

  it('promotes error actions for TS2339', () => {
    const { contentType, actions } = getRankedActions(
      "TS2339: Property 'translatedCrops' does not exist on type 'Crop'",
    );
    expect(contentType).toBe('error');
    expect(actions[0]?.id).toBe(AIAction.FIND_ROOT_CAUSE);
  });

  it('keeps normal TypeScript source on code ranking', () => {
    const code = [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
    ].join('\n');
    const { contentType, actions } = getRankedActions(code);
    expect(contentType).toBe('code');
    expect(actions[0]?.id).toBe(AIAction.EXPLAIN_CODE);
  });
});
