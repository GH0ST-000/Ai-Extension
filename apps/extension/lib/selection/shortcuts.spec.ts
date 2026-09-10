import { describe, expect, it } from 'vitest';
import { AIAction } from '@project-x/types';

import {
  AI_ACTIONS,
  SHORTCUT_TO_ACTION,
  actionFromShortcut,
  getActionDefinition,
} from './constants';
import { rankActions } from './smart-actions';

describe('shortcut → AIAction mapping', () => {
  it('maps fixed letters to action identities', () => {
    expect(SHORTCUT_TO_ACTION).toEqual({
      e: AIAction.EXPLAIN,
      i: AIAction.IMPROVE_WRITING,
      s: AIAction.SUMMARIZE,
      t: AIAction.TRANSLATE,
      c: AIAction.EXPLAIN_CODE,
      r: AIAction.REVIEW_CODE,
      f: AIAction.SUGGEST_FIX,
      a: AIAction.REVIEW_ENTIRE_PR,
      u: AIAction.UNDERSTAND_ERROR,
      o: AIAction.FIND_ROOT_CAUSE,
      j: AIAction.SUMMARIZE_JIRA_ISSUE,
      p: AIAction.CUSTOM,
    });
  });

  it('resolves case-insensitively and ignores non-shortcuts', () => {
    expect(actionFromShortcut('E')).toBe(AIAction.EXPLAIN);
    expect(actionFromShortcut('c')).toBe(AIAction.EXPLAIN_CODE);
    expect(actionFromShortcut('Enter')).toBeNull();
    expect(actionFromShortcut('')).toBeNull();
  });

  it('keeps the same AIAction after ranking reorders the menu', () => {
    const ranked = rankActions('code');
    expect(ranked[0]?.id).toBe(AIAction.EXPLAIN_CODE);

    // C still means Explain Code even though it is now index 0 (was index 4).
    const fromShortcut = actionFromShortcut('c');
    expect(fromShortcut).toBe(AIAction.EXPLAIN_CODE);
    expect(getActionDefinition(fromShortcut!)?.id).toBe(AIAction.EXPLAIN_CODE);

    // E still means Explain, not whatever sits at the old Explain index.
    expect(actionFromShortcut('e')).toBe(AIAction.EXPLAIN);
    expect(ranked.findIndex((action) => action.id === AIAction.EXPLAIN)).toBeGreaterThan(0);
  });

  it('catalog shortcuts stay aligned with SHORTCUT_TO_ACTION', () => {
    for (const action of AI_ACTIONS) {
      if (!action.shortcut) {
        continue;
      }
      expect(SHORTCUT_TO_ACTION[action.shortcut.toLowerCase()]).toBe(action.id);
    }
  });
});
