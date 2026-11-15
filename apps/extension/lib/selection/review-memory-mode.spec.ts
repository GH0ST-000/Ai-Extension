/**
 * Project Memory ON/OFF for PR reviews: the toggle's value is sent explicitly as
 * `projectMemoryMode`, retries keep the setting they ran with, and the report labels the
 * outcome. The request body is the same contract the API validates in
 * apps/api/src/ai/dto/execute-ai-action.dto.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIAction, type ProjectMemoryPromptMetadata } from '@project-x/types';

const streamAiActionMock = vi.fn();
const PR_CONTEXT = {
  type: 'github' as const,
  url: 'https://github.com/acme/app/pull/48',
  title: 'PR',
  github: { owner: 'acme', repository: 'app', pullRequestNumber: 48 },
};
const extractPageContextMock = vi.fn(() => PR_CONTEXT);

vi.mock('../services/ai-client', async () => {
  const actual = await vi.importActual('../services/ai-client');
  return {
    ...(actual as Record<string, unknown>),
    streamAiAction: (...args: unknown[]) => streamAiActionMock(...args),
  };
});
vi.mock('../context/extract-page-context', () => ({
  extractPageContext: () => extractPageContextMock(),
}));

const storage = new Map<string, unknown>();
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (key: string) => (storage.has(key) ? { [key]: storage.get(key) } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) storage.set(k, v);
      }),
    },
  },
});

import { REVIEW_MEMORY_MODE_STORAGE_KEY, useReviewMemoryModeStore } from '../project-memory';
import { buildAiRequest, parseProjectMemoryHeader } from '../services/ai-client';
import { useSelectionToolbarStore } from './store';
import { memoryAppliedRuleCount, memoryChipLabel } from './utils/project-memory-metadata';

const encode = (value: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const sent = (call = 0) => streamAiActionMock.mock.calls[call]![0] as Record<string, unknown>;

describe('PR review Project Memory toggle → request', () => {
  beforeEach(() => {
    storage.clear();
    streamAiActionMock.mockReset().mockResolvedValue('## Summary\nok');
    useReviewMemoryModeStore.setState({ mode: 'on', hydrated: false });
    useSelectionToolbarStore.setState({
      phase: 'assistant',
      selectedText: 'Review this PR.',
      assistant: { status: 'menu' },
      requestId: 0,
      abortController: null,
      lastReviewMemoryMode: null,
    });
  });

  it.each(['on', 'off'] as const)(
    'REVIEW_ENTIRE_PR sends the toggle value explicitly (%s)',
    async (mode) => {
      useReviewMemoryModeStore.getState().setMode(mode);
      await useSelectionToolbarStore.getState().startAction(AIAction.REVIEW_ENTIRE_PR);
      expect(sent()).toMatchObject({
        action: AIAction.REVIEW_ENTIRE_PR,
        projectMemoryMode: mode,
        memoryRepository: 'acme/app',
      });
      expect(useSelectionToolbarStore.getState().lastReviewMemoryMode).toBe(mode);
    },
  );

  it('other actions do not send a memory setting (server default unchanged)', async () => {
    useReviewMemoryModeStore.getState().setMode('off');
    await useSelectionToolbarStore.getState().startAction(AIAction.EXPLAIN);
    expect(sent()).not.toHaveProperty('projectMemoryMode');
  });

  it('a retry keeps the setting the review ran with, even after the toggle changed', async () => {
    useReviewMemoryModeStore.getState().setMode('off');
    await useSelectionToolbarStore.getState().startAction(AIAction.REVIEW_ENTIRE_PR);
    useReviewMemoryModeStore.getState().setMode('on');
    await useSelectionToolbarStore.getState().retry();
    expect(sent(1).projectMemoryMode).toBe('off');
    // Identical request (so the client can attach a lost-response retry id to it).
    expect(sent(1)).toEqual(sent(0));
    // A new review uses the new setting.
    await useSelectionToolbarStore.getState().startAction(AIAction.REVIEW_ENTIRE_PR);
    expect(sent(2).projectMemoryMode).toBe('on');
  });

  it('the server outcome is kept for the report (disabled)', async () => {
    streamAiActionMock.mockImplementation(async (_req, handlers) => {
      handlers.onProjectMemory?.(
        parseProjectMemoryHeader(
          encode({ status: 'disabled', requested: 'off', requestSource: 'explicit', ruleCount: 0 }),
        ),
      );
      return '## Summary\nok';
    });
    useReviewMemoryModeStore.getState().setMode('off');
    await useSelectionToolbarStore.getState().startAction(AIAction.REVIEW_ENTIRE_PR);
    const memory = useSelectionToolbarStore.getState().lastReviewMemory;
    expect(memory).toEqual({
      status: 'disabled',
      requested: 'off',
      requestSource: 'explicit',
      ruleCount: 0,
    });
    expect(memoryChipLabel(memory)).toBe('Off for this review');
  });
});

describe('request body contract', () => {
  it('buildAiRequest produces exactly the body the API contract test validates', () => {
    expect(
      buildAiRequest({
        action: AIAction.REVIEW_ENTIRE_PR,
        text: 'Review this PR.',
        context: PR_CONTEXT,
        memoryRepository: 'acme/app',
        projectMemoryMode: 'off',
      }),
    ).toEqual({
      action: AIAction.REVIEW_ENTIRE_PR,
      text: 'Review this PR.',
      customPrompt: null,
      targetLanguage: null,
      context: PR_CONTEXT,
      errorIntelligence: null,
      memoryRepository: 'acme/app',
      projectMemoryMode: 'off',
    });
  });

  it('omits the field only when no setting was chosen', () => {
    expect(buildAiRequest({ action: AIAction.EXPLAIN, text: 'x' })).not.toHaveProperty(
      'projectMemoryMode',
    );
  });
});

describe('toggle persistence', () => {
  beforeEach(() => storage.clear());

  it('saves the choice and restores it on the next page', async () => {
    useReviewMemoryModeStore.setState({ mode: 'on', hydrated: false });
    useReviewMemoryModeStore.getState().setMode('off');
    await Promise.resolve();
    expect(storage.get(REVIEW_MEMORY_MODE_STORAGE_KEY)).toBe('off');

    useReviewMemoryModeStore.setState({ mode: 'on', hydrated: false });
    await useReviewMemoryModeStore.getState().hydrate();
    expect(useReviewMemoryModeStore.getState()).toMatchObject({ mode: 'off', hydrated: true });
  });

  it('ignores a corrupted stored value (stays on)', async () => {
    storage.set(REVIEW_MEMORY_MODE_STORAGE_KEY, 'maybe');
    useReviewMemoryModeStore.setState({ mode: 'on', hydrated: false });
    await useReviewMemoryModeStore.getState().hydrate();
    expect(useReviewMemoryModeStore.getState().mode).toBe('on');
  });
});

describe('memory metadata in the report', () => {
  const RULE = {
    id: 'mem-1',
    key: 'rule.isolation',
    category: 'SECURITY_CONVENTION',
    title: '',
    confidence: 'high',
    visibility: 'workspace',
  };

  it('parses disabled, applied (with count) and skipped with the request record', () => {
    expect(parseProjectMemoryHeader(encode({ status: 'disabled' }))).toEqual({
      status: 'disabled',
      requested: 'off',
      ruleCount: 0,
    });
    const applied = parseProjectMemoryHeader(
      encode({
        status: 'applied',
        version: 'v',
        rules: [RULE],
        requested: 'on',
        requestSource: 'default',
        ruleCount: 1,
      }),
    );
    expect(applied).toMatchObject({ requested: 'on', requestSource: 'default', ruleCount: 1 });
    expect(memoryChipLabel(applied)).toBe('Applied · 1 rule');
    expect(memoryAppliedRuleCount(applied)).toBe(1);
    const skipped = parseProjectMemoryHeader(
      encode({ status: 'skipped', reason: 'no_active_rules', requested: 'on', ruleCount: 0 }),
    );
    expect(memoryChipLabel(skipped)).toBe('Skipped · no rules applied');
    expect(memoryAppliedRuleCount(skipped)).toBe(0);
  });

  it('drops malformed request records instead of trusting them', () => {
    const parsed = parseProjectMemoryHeader(
      encode({ status: 'skipped', reason: 'no_active_rules', requested: 'maybe', ruleCount: -3 }),
    ) as ProjectMemoryPromptMetadata;
    expect(parsed).toEqual({ status: 'skipped', reason: 'no_active_rules' });
  });
});
