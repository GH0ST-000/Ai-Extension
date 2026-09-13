import { describe, expect, it } from 'vitest';
import { decideRetry } from '@project-x/shared';

describe('Day 29 unknown-write retry policy', () => {
  it('never auto-retries GitHub write / patch / review stages', () => {
    for (const stage of ['GITHUB_WRITE', 'PATCH_APPLY', 'REVIEW_SUBMIT'] as const) {
      const decision = decideRetry({
        stage,
        category: 'NETWORK',
        attempt: 0,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.requiresConfirmation).toBe(true);
    }
  });
});
