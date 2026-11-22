/**
 * F-07: every GitHub route that reaches the AI provider or the GitHub API on the caller's
 * behalf is rate limited, and the guard that enforces the declared policies is installed on
 * the controller (a policy without the guard does nothing).
 */
import 'reflect-metadata';

import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { OpenApiController } from '../openapi/openapi.controller';
import {
  RATE_LIMIT_KEY,
  RateLimitGuard,
  type RateLimitPolicy,
} from '../common/security/rate-limit.guard';
import { GithubController } from './github.controller';

function policyOf(controller: { prototype: object }, method: string): RateLimitPolicy | undefined {
  const handler = (controller.prototype as Record<string, unknown>)[method] as object;
  return (
    (Reflect.getMetadata(RATE_LIMIT_KEY, handler) as RateLimitPolicy | undefined) ??
    (Reflect.getMetadata(RATE_LIMIT_KEY, controller) as RateLimitPolicy | undefined)
  );
}

const routeMethods = (controller: { prototype: object }) =>
  Object.getOwnPropertyNames(controller.prototype).filter(
    (name) =>
      name !== 'constructor' &&
      Reflect.hasMetadata('path', (controller.prototype as Record<string, object>)[name]!),
  );

describe('rate limits on provider-reaching routes (F-01 / F-07)', () => {
  it.each([
    ['GithubController', GithubController],
    ['OpenApiController', OpenApiController],
  ])('%s installs RateLimitGuard and every route has a policy', (_name, controller) => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ?? [];
    expect(guards).toContain(RateLimitGuard);
    const methods = routeMethods(controller);
    expect(methods.length).toBeGreaterThan(3);
    for (const method of methods) {
      const policy = policyOf(controller, method);
      expect(policy, `${method} has no @RateLimit`).toBeDefined();
      expect(policy!.limit).toBeGreaterThan(0);
      expect(policy!.windowSeconds).toBeGreaterThan(0);
    }
  });

  it('CI failure analysis (a model call per request) has its own, tighter budget', () => {
    expect(policyOf(GithubController, 'analyzeCheckFailure')).toEqual({
      bucket: 'ai_ci_analysis',
      limit: 20,
      windowSeconds: 60,
    });
  });
});
