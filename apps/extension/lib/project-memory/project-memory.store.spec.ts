import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIAction } from '@project-x/types';

import { parseOwnerRepo } from './project-memory.api';
import {
  capabilityForAiAction,
  prependProjectMemoryBlock,
  shouldPackProjectMemory,
  useProjectMemoryStore,
} from './project-memory.store';

vi.mock('./project-memory.api', async () => {
  const actual = (await vi.importActual('./project-memory.api')) as Record<string, unknown>;
  return {
    ...actual,
    fetchProjectMemorySummary: vi.fn(),
    fetchProjectMemoryList: vi.fn(),
    learnProjectMemory: vi.fn(),
  };
});

import { fetchProjectMemorySummary, learnProjectMemory } from './project-memory.api';

describe('parseOwnerRepo', () => {
  it('parses owner/repo', () => {
    expect(parseOwnerRepo('acme/pay')).toEqual({ owner: 'acme', repo: 'pay' });
    expect(parseOwnerRepo('/acme/pay/')).toEqual({ owner: 'acme', repo: 'pay' });
    expect(parseOwnerRepo('acme')).toBeNull();
    expect(parseOwnerRepo('')).toBeNull();
  });
});

describe('project-memory.store helpers', () => {
  it('maps AI actions to capabilities', () => {
    expect(capabilityForAiAction(AIAction.REVIEW_ENTIRE_PR)).toBe('PR_REVIEW');
    expect(capabilityForAiAction(AIAction.SUGGEST_FIX)).toBe('GENERATE_PATCH');
    expect(capabilityForAiAction(AIAction.CREATE_TECHNICAL_PLAN)).toBe('JIRA_TECH_PLAN');
    expect(capabilityForAiAction(AIAction.SUMMARIZE)).toBeNull();
  });

  it('does not pack memory for PLAN_DEVELOPER_WORKFLOW or text actions', () => {
    expect(shouldPackProjectMemory(AIAction.PLAN_DEVELOPER_WORKFLOW)).toBe(false);
    expect(shouldPackProjectMemory(AIAction.IMPROVE_WRITING)).toBe(false);
    expect(shouldPackProjectMemory(AIAction.TRANSLATE)).toBe(false);
    expect(shouldPackProjectMemory(AIAction.REVIEW_ENTIRE_PR)).toBe(true);
  });

  it('prepends memory once', () => {
    const block = 'PROJECT_MEMORY\nversion: v1';
    const once = prependProjectMemoryBlock('SEL text', block);
    expect(once.startsWith('PROJECT_MEMORY')).toBe(true);
    expect(prependProjectMemoryBlock(once, block)).toBe(once);
    expect(prependProjectMemoryBlock('SEL', '')).toBe('SEL');
  });
});

describe('useProjectMemoryStore', () => {
  beforeEach(() => {
    useProjectMemoryStore.getState().clear();
    vi.mocked(fetchProjectMemorySummary).mockReset();
    vi.mocked(learnProjectMemory).mockReset();
  });

  it('caches summary fetches for the session', async () => {
    vi.mocked(fetchProjectMemorySummary).mockResolvedValue({
      version: 'pmv-1-abc',
      relevantRules: [
        {
          category: 'ARCHITECTURE',
          key: 'stack',
          text: 'Nest + React',
          confidence: 'high',
        },
      ],
    });

    const first = await useProjectMemoryStore.getState().fetchSummary('acme', 'pay', {
      capability: 'PLANNING',
    });
    const second = await useProjectMemoryStore.getState().fetchSummary('acme', 'pay', {
      capability: 'PLANNING',
    });

    expect(first?.version).toBe('pmv-1-abc');
    expect(second?.version).toBe('pmv-1-abc');
    expect(fetchProjectMemorySummary).toHaveBeenCalledTimes(1);
  });

  it('returns null when summary fetch fails', async () => {
    vi.mocked(fetchProjectMemorySummary).mockRejectedValue(new Error('network'));
    const summary = await useProjectMemoryStore.getState().fetchSummary('acme', 'pay', {
      capability: 'PR_REVIEW',
    });
    expect(summary).toBeNull();
  });

  it('learn clears summary cache', async () => {
    vi.mocked(fetchProjectMemorySummary).mockResolvedValue({
      version: 'pmv-1-abc',
      relevantRules: [],
    });
    await useProjectMemoryStore.getState().fetchSummary('acme', 'pay', {
      capability: 'PLANNING',
    });
    expect(Object.keys(useProjectMemoryStore.getState().summaryCache).length).toBe(1);

    vi.mocked(learnProjectMemory).mockResolvedValue({
      memoryVersion: 'pmv-2-def',
      accepted: [],
      candidates: [],
    });
    await useProjectMemoryStore.getState().learn('acme', 'pay');
    expect(useProjectMemoryStore.getState().summaryCache).toEqual({});
    expect(useProjectMemoryStore.getState().memoryVersion).toBe('pmv-2-def');
  });
});
