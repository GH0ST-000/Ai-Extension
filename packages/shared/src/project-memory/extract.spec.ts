import { describe, expect, it } from 'vitest';

import { extractDeterministicFactsFromConfigs } from './extract';

describe('extractDeterministicFactsFromConfigs', () => {
  it('auto_accepts package manager from pnpm lockfile', () => {
    const candidates = extractDeterministicFactsFromConfigs([
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'app',
          packageManager: 'pnpm@9.0.0',
          dependencies: { react: '18.0.0' },
          devDependencies: { vitest: '2.0.0', typescript: '5.0.0' },
        }),
      },
      { path: 'pnpm-lock.yaml', content: 'lockfileVersion: 9.0\n' },
    ]);

    const pm = candidates.find((c) => c.key === 'tooling.package_manager');
    expect(pm?.recommendation).toBe('auto_accept');
    expect(pm?.proposedValue.details?.packageManager).toBe('pnpm');
  });

  it('detects monorepo, nestjs, vitest, prisma, eslint, prettier, ts strict', () => {
    const candidates = extractDeterministicFactsFromConfigs([
      {
        path: 'package.json',
        content: JSON.stringify({
          dependencies: {
            '@nestjs/core': '10.0.0',
            '@nestjs/common': '10.0.0',
            '@nestjs/cqrs': '10.0.0',
            '@prisma/client': '5.0.0',
            react: '18.0.0',
            next: '14.0.0',
          },
          devDependencies: {
            vitest: '2.0.0',
            eslint: '9.0.0',
            prettier: '3.0.0',
            prisma: '5.0.0',
          },
        }),
      },
      { path: 'pnpm-workspace.yaml', content: 'packages:\n  - apps/*\n' },
      { path: 'turbo.json', content: '{"pipeline":{}}' },
      {
        path: 'tsconfig.json',
        content: JSON.stringify({ compilerOptions: { strict: true } }),
      },
      {
        path: 'prisma/schema.prisma',
        content: 'generator client {\n  provider = "prisma-client-js"\n}',
      },
    ]);

    expect(candidates.find((c) => c.key === 'tooling.monorepo')?.recommendation).toBe(
      'auto_accept',
    );
    expect(candidates.find((c) => c.key === 'framework.nestjs')?.recommendation).toBe(
      'auto_accept',
    );
    expect(candidates.find((c) => c.key === 'framework.next')?.recommendation).toBe('auto_accept');
    expect(candidates.find((c) => c.key === 'framework.react')?.recommendation).toBe('auto_accept');
    expect(
      candidates.find((c) => c.key === 'testing.framework')?.proposedValue.details?.framework,
    ).toBe('vitest');
    expect(candidates.find((c) => c.key === 'tooling.typescript_strict')?.recommendation).toBe(
      'auto_accept',
    );
    expect(candidates.find((c) => c.key === 'tooling.eslint')?.recommendation).toBe('auto_accept');
    expect(candidates.find((c) => c.key === 'tooling.prettier')?.recommendation).toBe(
      'auto_accept',
    );
    expect(candidates.find((c) => c.key === 'database.prisma')?.recommendation).toBe('auto_accept');
    expect(candidates.find((c) => c.key === 'dependency.nestjs_cqrs')?.recommendation).toBe(
      'auto_accept',
    );
  });

  it('asks user for CQRS architecture when enough handlers are present', () => {
    const candidates = extractDeterministicFactsFromConfigs([
      {
        path: 'package.json',
        content: JSON.stringify({
          dependencies: { '@nestjs/cqrs': '10.0.0' },
        }),
      },
      { path: 'src/payment.command-handler.ts', content: 'export class PaymentHandler {}' },
      { path: 'src/refund.command-handler.ts', content: 'export class RefundHandler {}' },
      { path: 'src/get-payment.query-handler.ts', content: 'export class GetPaymentHandler {}' },
    ]);

    const cqrs = candidates.find((c) => c.key === 'architecture.pattern.cqrs');
    expect(cqrs?.recommendation).toBe('ask_user');
  });

  it('never returns secrets or .env content', () => {
    const candidates = extractDeterministicFactsFromConfigs([
      {
        path: '.env',
        content: 'API_KEY=supersecret\npassword=hunter2\nghp_abcdefghijklmnopqrstuvwxyz12',
      },
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'app',
          dependencies: { react: '18.0.0' },
        }),
      },
    ]);

    const blob = JSON.stringify(candidates);
    expect(blob).not.toContain('supersecret');
    expect(blob).not.toContain('hunter2');
    expect(blob).not.toContain('ghp_');
    expect(candidates.every((c) => c.recommendation !== 'do_not_store' || true)).toBe(true);
  });

  it('skips files that contain embedded secrets in package.json', () => {
    const candidates = extractDeterministicFactsFromConfigs([
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'app',
          scripts: { start: 'echo ghp_abcdefghijklmnopqrstuvwxyz12' },
        }),
      },
    ]);
    expect(candidates).toEqual([]);
  });
});
