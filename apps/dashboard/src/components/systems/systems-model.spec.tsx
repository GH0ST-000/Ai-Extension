import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiError } from '../../lib/api';
import {
  PROVENANCE_LABELS,
  analysisUsage,
  describeError,
  lastValidatedAt,
  parseRepositoryInput,
  scanNotes,
  summarizeDiscovery,
  summarizeRefresh,
} from './systems-model';
import { Callout } from './systems-ui';

afterEach(() => cleanup());

const repo = (owner: string, repository: string) => ({
  provider: 'github' as const,
  owner,
  repository,
});

describe('parseRepositoryInput', () => {
  it.each([
    ['acme/payments-api', 'acme', 'payments-api'],
    ['  acme/payments-api  ', 'acme', 'payments-api'],
    ['https://github.com/acme/payments-api', 'acme', 'payments-api'],
    ['github.com/acme/payments-api.git', 'acme', 'payments-api'],
    ['https://www.github.com/acme/web/pull/12?x=1#y', 'acme', 'web'],
    ['my-org/repo.name_v2', 'my-org', 'repo.name_v2'],
  ])('%s → %s/%s', (input, owner, repository) => {
    expect(parseRepositoryInput(input)).toEqual({ ok: true, owner, repository });
  });

  it.each([
    ['', /Enter a repository/],
    ['acme', /owner\/repository/],
    ['https://gitlab.com/acme/web', /Only GitHub/],
    ['-acme/web', /not a valid GitHub owner/],
    ['ac me/web', /not a valid GitHub owner/],
    ['acme/we b', /not a valid repository name/],
    ['acme/..', /not a valid repository name/],
  ])('rejects %j', (input, message) => {
    const result = parseRepositoryInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
});

describe('analysis summaries', () => {
  it('the example from the spec reads as a plain success', () => {
    const s = summarizeRefresh(
      { analyzed: 1, relationshipsChecked: 0, candidates: [], unavailable: [], truncated: false },
      1,
    );
    expect(s).toMatchObject({
      tone: 'success',
      title: 'Analysis completed',
      lines: ['1 repository analyzed.', 'No relationships found.'],
      suggestAddRepository: true,
    });
  });

  it('warnings for unavailable repositories or truncation; no add-suggestion for larger systems', () => {
    const s = summarizeRefresh(
      {
        analyzed: 3,
        relationshipsChecked: 1,
        candidates: [],
        unavailable: [repo('a', 'b')],
        truncated: false,
      },
      3,
    );
    expect(s.tone).toBe('warning');
    expect(s.lines).toEqual([
      '3 repositories analyzed.',
      '1 relationship found.',
      'No new related repositories suggested.',
    ]);
    expect(s.suggestAddRepository).toBe(false);
    expect(
      summarizeDiscovery({ systemId: 's', relationships: [], candidates: [], truncated: true }, 2),
    ).toMatchObject({ tone: 'warning', title: 'Discovery completed with partial results' });
  });
});

describe('analysisUsage', () => {
  const counter = (over: Partial<Record<string, unknown>> = {}) => ({
    workspaceId: 'ws',
    metric: 'multi_repo_analysis' as const,
    period: '2026-11',
    count: 7,
    limit: 10,
    remaining: 3,
    ...over,
  });
  const NOW = new Date('2026-11-18T12:00:00Z');

  it('reports current-month usage only; unlimited, missing or stale data → null', () => {
    expect(analysisUsage([counter()], NOW)).toEqual({ used: 7, limit: 10, remaining: 3 });
    expect(analysisUsage([counter({ limit: null, remaining: null })], NOW)).toBeNull();
    expect(analysisUsage([counter({ period: '2026-10' })], NOW)).toBeNull();
    expect(analysisUsage([counter({ metric: 'ai_action' })], NOW)).toBeNull();
    expect(analysisUsage(undefined, NOW)).toBeNull();
  });
});

describe('describeError', () => {
  it('maps known API codes to next steps; only transient failures are retryable', () => {
    expect(describeError(new ApiError('x', 403, 'FEATURE_NOT_AVAILABLE'), 'f')).toMatchObject({
      retryable: false,
      action: { href: '/app/billing' },
    });
    expect(
      describeError(new ApiError('x', 403, 'SYSTEM_REPOSITORY_NOT_ACCESSIBLE'), 'f'),
    ).toMatchObject({
      retryable: false,
      action: { href: '/app/settings' },
    });
    expect(
      describeError(new ApiError('GitHub down', 503, 'SYSTEM_CONTEXT_STALE'), 'f').retryable,
    ).toBe(true);
    expect(describeError(new ApiError('Bad input', 400), 'Fallback')).toMatchObject({
      title: 'Fallback',
      message: 'Bad input',
      retryable: false,
    });
    expect(describeError(new TypeError('network'), 'Fallback').retryable).toBe(true);
  });
});

describe('scanNotes', () => {
  it('summarizes partial repositories, invalid manifests and unmatched calls; nothing when complete', () => {
    expect(scanNotes(undefined)).toEqual([]);
    expect(
      scanNotes({
        partial: false,
        githubRequests: 4,
        repositories: [
          {
            repository: repo('a', 'b'),
            status: 'complete',
            filesScanned: 4,
            issues: [],
            unresolvedHttpCalls: 0,
          },
        ],
      }),
    ).toEqual([]);
    expect(
      scanNotes({
        partial: true,
        githubRequests: 4,
        repositories: [
          {
            repository: repo('a', 'b'),
            status: 'partial',
            filesScanned: 1,
            issues: [{ code: 'manifest_invalid', count: 1 }],
            unresolvedHttpCalls: 1,
          },
        ],
      }),
    ).toEqual([
      'a/b was only partly read: service-dependencies.json is not valid.',
      '1 HTTP call could not be matched to exactly one repository in this system, so no relationship was recorded for it.',
    ]);
    expect(PROVENANCE_LABELS.service_manifest).toBe('Declared in service-dependencies.json');
  });
});

describe('lastValidatedAt', () => {
  it('uses only real timestamps', () => {
    expect(lastValidatedAt([])).toBeNull();
    expect(
      lastValidatedAt([
        { lastValidatedAt: '2026-11-01T00:00:00.000Z' },
        { freshness: { lastValidatedAt: '2026-11-03T00:00:00.000Z' } },
        { lastValidatedAt: 'garbage' },
      ]),
    ).toBe('2026-11-03T00:00:00.000Z');
  });
});

describe('theme compatibility', () => {
  it('warning and error callouts define dark-mode colors; neutral info uses theme tokens', () => {
    render(
      <>
        <Callout tone="warning" title="w" />
        <Callout tone="error" title="e" />
        <Callout tone="info" title="i" />
      </>,
    );
    const box = (t: string) => screen.getByText(t).parentElement!.className;
    expect(box('w')).toMatch(/dark:/);
    expect(box('e')).toMatch(/dark:/);
    expect(box('i')).not.toMatch(/#[0-9a-f]{6}/i);
  });
});

describe('N-9: rate-limit guidance', () => {
  it('a 429 RATE_LIMITED is explained and not offered as an immediate retry', () => {
    const guidance = describeError(
      new ApiError('Too many requests. Please wait and try again.', 429, 'RATE_LIMITED'),
      'Discovery failed',
    );
    expect(guidance.title).toBe('Too many analyses in a short time');
    expect(guidance.retryable).toBe(false);
  });
});
