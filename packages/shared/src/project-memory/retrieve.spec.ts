import { describe, expect, it } from 'vitest';
import type { ProjectMemoryItem } from '@project-x/types';

import { selectRelevantMemory } from './retrieve';

function item(
  partial: Partial<ProjectMemoryItem> & Pick<ProjectMemoryItem, 'id' | 'key'>,
): ProjectMemoryItem {
  return {
    id: partial.id,
    project: partial.project ?? { provider: 'github', owner: 'acme', repository: 'app' },
    category: partial.category ?? 'ARCHITECTURE',
    key: partial.key,
    value: partial.value ?? { summary: `Summary for ${partial.key}` },
    confidence: partial.confidence ?? 'medium',
    status: partial.status ?? 'active',
    provenance: partial.provenance ?? [
      {
        type: 'repository_observation',
        observedAt: '2026-09-12T00:00:00.000Z',
        summary: 'observed',
      },
    ],
    scope: partial.scope ?? { type: 'repository' },
    createdAt: partial.createdAt ?? '2026-09-12T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-09-12T00:00:00.000Z',
  };
}

describe('selectRelevantMemory', () => {
  it('excludes superseded, disputed, and archived', () => {
    const selected = selectRelevantMemory(
      [
        item({ id: '1', key: 'a', status: 'active', confidence: 'high' }),
        item({ id: '2', key: 'b', status: 'superseded', confidence: 'high' }),
        item({ id: '3', key: 'c', status: 'disputed', confidence: 'high' }),
        item({ id: '4', key: 'd', status: 'archived', confidence: 'high' }),
      ],
      { maxItems: 10, maxChars: 10_000 },
    );
    expect(selected.map((i) => i.id)).toEqual(['1']);
  });

  it('prefers user_explicit and high confidence', () => {
    const selected = selectRelevantMemory(
      [
        item({
          id: 'low',
          key: 'low',
          confidence: 'low',
          provenance: [
            {
              type: 'workflow_result',
              observedAt: '2026-09-12T00:00:00.000Z',
              summary: 'weak',
            },
          ],
        }),
        item({
          id: 'user',
          key: 'user_rule',
          confidence: 'high',
          category: 'PROJECT_CONSTRAINT',
          provenance: [
            {
              type: 'user_explicit',
              observedAt: '2026-09-12T00:00:00.000Z',
              summary: 'user',
            },
          ],
        }),
      ],
      { maxItems: 1, maxChars: 10_000 },
    );
    expect(selected[0]?.id).toBe('user');
  });

  it('prefers matching directory/file-pattern scope over repository', () => {
    const selected = selectRelevantMemory(
      [
        item({
          id: 'repo',
          key: 'repo_fact',
          confidence: 'high',
          scope: { type: 'repository' },
        }),
        item({
          id: 'dir',
          key: 'dir_fact',
          confidence: 'high',
          scope: { type: 'directory', path: 'apps/api' },
        }),
        item({
          id: 'file',
          key: 'file_fact',
          confidence: 'high',
          scope: { type: 'file-pattern', pattern: 'apps/api/**/*.ts' },
        }),
      ],
      {
        pathHints: ['apps/api/src/main.ts'],
        maxItems: 2,
        maxChars: 10_000,
      },
    );
    expect(selected.map((i) => i.id)).toEqual(['file', 'dir']);
  });

  it('filters by categories and respects budgets', () => {
    const selected = selectRelevantMemory(
      [
        item({ id: '1', key: 'a', category: 'ARCHITECTURE', confidence: 'high' }),
        item({ id: '2', key: 'b', category: 'TESTING_CONVENTION', confidence: 'high' }),
        item({
          id: '3',
          key: 'c',
          category: 'ARCHITECTURE',
          confidence: 'high',
          value: { summary: 'x'.repeat(500) },
        }),
      ],
      {
        categories: ['ARCHITECTURE'],
        maxItems: 1,
        maxChars: 200,
      },
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.category).toBe('ARCHITECTURE');
    expect(selected[0]?.id).toBe('1');
  });
});
