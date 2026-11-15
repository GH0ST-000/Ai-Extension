import { BadRequestException } from '@nestjs/common';
import type { ProjectMemoryPromptMetadata } from '@project-x/types';
import { describe, expect, it } from 'vitest';

import { validatedFinding } from '../ai/pr-review/pr-review-fixtures';
import { decodeCursor, encodeCursor } from './pr-review-history.service';
import {
  MAX_REPORT_MARKDOWN_CHARS,
  buildPrReviewSnapshot,
  capMarkdown,
  memoryForViewer,
  toStoredMemory,
} from './pr-review-history.snapshot';

const applied: ProjectMemoryPromptMetadata = {
  status: 'applied',
  version: 'v1',
  requested: 'on',
  requestSource: 'default',
  ruleCount: 2,
  rules: [
    {
      id: 'r1',
      key: 'k.shared',
      category: 'convention' as never,
      title: 'Shared text',
      confidence: 'high',
      visibility: 'workspace',
    },
    {
      id: 'r2',
      key: 'k.mine',
      category: 'preference' as never,
      title: 'Private text',
      confidence: 'low',
      visibility: 'user',
    },
  ],
};

describe('PR review history snapshot', () => {
  it('stores reported and needs-investigation findings, never dismissed ones', () => {
    const snapshot = buildPrReviewSnapshot({
      status: 'completed',
      coverage: null,
      reviewScope: null,
      findings: [
        validatedFinding({ stableId: 'a', disposition: 'reported' }),
        validatedFinding({ stableId: 'b', disposition: 'needs_investigation' }),
        validatedFinding({ stableId: 'c', disposition: 'dismissed' }),
      ],
      outcomes: [{ id: 'b1', status: 'succeeded', attempts: 1, files: 1 }],
      durationMs: 12.6,
      batchCount: 1,
    });
    expect(snapshot.version).toBe(1);
    expect(snapshot.findings.map((f) => f.stableId)).toEqual(['a', 'b']);
    expect(snapshot.execution).toEqual({
      durationMs: 13,
      batches: 1,
      batchesSucceeded: 1,
      batchesFailed: 0,
    });
    expect(snapshot.failure).toBeUndefined();
  });

  it('caps long finding text and evidence', () => {
    const snapshot = buildPrReviewSnapshot({
      status: 'completed',
      coverage: null,
      reviewScope: null,
      findings: [
        validatedFinding({ explanation: 'x'.repeat(10_000), evidence: 'y'.repeat(10_000) }),
      ],
      outcomes: [],
      durationMs: 1,
      batchCount: 1,
    });
    expect(snapshot.findings[0]!.explanation.length).toBeLessThanOrEqual(2_000);
    expect(snapshot.findings[0]!.evidence.length).toBeLessThanOrEqual(1_000);
  });

  it('records failures: explicit failure codes and failed batches of a partial run', () => {
    const failed = buildPrReviewSnapshot({
      status: 'failed',
      failureCode: 'all_batches_failed',
      coverage: null,
      reviewScope: null,
      findings: [],
      outcomes: [
        { id: 'b1', status: 'failed', attempts: 2, files: 1, errorCode: 'provider_error' },
      ],
      durationMs: 1,
      batchCount: 1,
    });
    expect(failed.failure).toEqual({ code: 'all_batches_failed', failedBatches: 1 });
    const partial = buildPrReviewSnapshot({
      status: 'partial',
      coverage: null,
      reviewScope: null,
      findings: [],
      outcomes: [
        { id: 'b1', status: 'failed', attempts: 2, files: 1 },
        { id: 'b2', status: 'succeeded', attempts: 1, files: 1 },
      ],
      durationMs: 1,
      batchCount: 2,
    });
    expect(partial.failure).toEqual({ code: 'some_batches_failed', failedBatches: 1 });
  });

  it('memory: no rule text, personal rules as a count only', () => {
    const stored = toStoredMemory(applied)!;
    expect(JSON.stringify(stored)).not.toMatch(/Shared text|Private text|r2|k\.mine/);
    expect(stored).toEqual({
      mode: 'on',
      status: 'applied',
      requestSource: 'default',
      ruleCount: 2,
      sharedRules: [{ id: 'r1', key: 'k.shared', category: 'convention', confidence: 'high' }],
      personalRuleCount: 1,
    });
    expect(toStoredMemory({ status: 'disabled', requested: 'off' })).toMatchObject({
      mode: 'off',
      status: 'disabled',
      ruleCount: 0,
    });
    expect(toStoredMemory({ status: 'skipped', reason: 'no_active_rules' })).toMatchObject({
      mode: 'on',
      skipReason: 'no_active_rules',
    });
    expect(toStoredMemory(undefined)).toBeNull();
  });

  it('memory: only the initiator learns that personal preferences were applied', () => {
    const stored = toStoredMemory(applied)!;
    expect(memoryForViewer(stored, true)).toEqual(stored);
    const other = memoryForViewer(stored, false)!;
    expect(other).not.toHaveProperty('personalRuleCount');
    expect(other.ruleCount).toBe(1);
  });

  it('omits oversized markdown instead of truncating it', () => {
    expect(capMarkdown('ok')).toBe('ok');
    expect(capMarkdown('x'.repeat(MAX_REPORT_MARKDOWN_CHARS + 1))).toBeNull();
    expect(capMarkdown(null)).toBeNull();
  });
});

describe('PR review history cursor', () => {
  it('round-trips and rejects tampered input', () => {
    const at = new Date('2026-11-15T10:00:00.000Z');
    expect(decodeCursor(encodeCursor(at, 'clabc123'))).toEqual({ createdAt: at, id: 'clabc123' });
    for (const bad of [
      '',
      'garbage',
      Buffer.from('2026|x y').toString('base64url'),
      Buffer.from('nope|clabc').toString('base64url'),
    ]) {
      expect(() => decodeCursor(bad)).toThrow(BadRequestException);
    }
  });
});
