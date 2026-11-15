/**
 * Regression: boolean request fields must be real JSON booleans.
 *
 * With the production ValidationPipe (`enableImplicitConversion`), a plain `@IsBoolean()`
 * property turned `"false"` / `"no"` / `1` into `true`. Every boolean request property now uses
 * `@StrictBoolean()`; these tests run each affected DTO through the same pipe options as
 * src/main.ts.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ErrorClassificationDto, PageContextGitHubDto } from '../../ai/dto/execute-ai-action.dto';
import { AddRepositoryDto } from '../../multi-repo/dto/add-repository.dto';
import { CreateSystemDto } from '../../multi-repo/dto/create-system.dto';
import { UpdateRepositoryDto } from '../../multi-repo/dto/update-repository.dto';
import { ClearProjectMemoryDto } from '../../project-memory/dto/clear-memory.dto';
import { RetryExecutionDto } from '../../reliability/dto/reliability.dto';
import { UpdateOnboardingDto } from '../../settings/dto/update-onboarding.dto';
import { UpdateSettingsDto } from '../../settings/dto/update-settings.dto';

/** Same options as src/main.ts. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const validate = (metatype: new () => object, body: unknown) =>
  pipe.transform(body, { type: 'body', metatype }) as Promise<Record<string, unknown>>;

type Case = {
  endpoint: string;
  dto: new () => object;
  /** Builds a valid body with the boolean under test set to `value`. */
  body: (value: unknown) => Record<string, unknown>;
  /** Reads the boolean back from the transformed DTO. */
  read: (dto: Record<string, unknown>) => unknown;
  /** Values that are valid for this field (default both). */
  accepted?: boolean[];
};

const flat = (field: string, base: Record<string, unknown> = {}) => ({
  body: (value: unknown) => ({ ...base, [field]: value }),
  read: (dto: Record<string, unknown>) => dto[field],
});

const CASES: Case[] = [
  {
    endpoint: 'POST /projects/:owner/:repo/memory/clear  { confirm }',
    dto: ClearProjectMemoryDto,
    ...flat('confirm'),
    accepted: [true],
  },
  {
    endpoint: 'POST /reliability/executions/:id/retry  { writeConfirmed }',
    dto: RetryExecutionDto,
    ...flat('writeConfirmed', { stage: 'AI_FETCH', category: 'NETWORK' }),
  },
  {
    endpoint: 'POST /reliability/executions/:id/retry  { idempotentSafe }',
    dto: RetryExecutionDto,
    ...flat('idempotentSafe', { stage: 'AI_FETCH', category: 'NETWORK' }),
  },
  {
    endpoint: 'PATCH settings  { includePageContext }',
    dto: UpdateSettingsDto,
    ...flat('includePageContext'),
  },
  {
    endpoint: 'multi-repo add repository  { enabled }',
    dto: AddRepositoryDto,
    ...flat('enabled', { owner: 'acme', repository: 'api' }),
  },
  {
    endpoint: 'multi-repo update repository  { enabled }',
    dto: UpdateRepositoryDto,
    ...flat('enabled'),
  },
  {
    endpoint: 'multi-repo create system  { repositories[].enabled }',
    dto: CreateSystemDto,
    body: (value) => ({
      name: 'Payments',
      primaryOwner: 'acme',
      primaryRepository: 'api',
      repositories: [{ owner: 'acme', repository: 'web', enabled: value }],
    }),
    read: (dto) => (dto.repositories as Array<Record<string, unknown>>)[0]!.enabled,
  },
  ...(['welcomeSeen', 'dismiss', 'firstWriteEducationSeen'] as const).map((field) => ({
    endpoint: `PATCH onboarding  { ${field} }`,
    dto: UpdateOnboardingDto,
    ...flat(field),
  })),
  {
    endpoint: 'AI execute  { context.github.changedFilesTruncated }',
    dto: PageContextGitHubDto,
    ...flat('changedFilesTruncated'),
  },
  {
    endpoint: 'AI execute  { context.github.filesTab }',
    dto: PageContextGitHubDto,
    ...flat('filesTab'),
  },
  {
    endpoint: 'AI execute  { errorContext.classification.isError }',
    dto: ErrorClassificationDto,
    ...flat('isError', { confidence: 0.5 }),
  },
];

const COERCIBLE = ['false', 'true', 'no', '0', '', 1, 0, {}, []];

describe('StrictBoolean request fields', () => {
  describe.each(CASES)('$endpoint', ({ dto, body, read, accepted = [true, false] }) => {
    it.each(accepted)('accepts JSON %s unchanged', async (value) => {
      expect(read(await validate(dto, body(value)))).toBe(value);
    });

    it.each(COERCIBLE)('rejects %j (no implicit conversion to a boolean)', async (value) => {
      await expect(validate(dto, body(value))).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('clear rejects confirm:false and a missing confirm', async () => {
    await expect(validate(ClearProjectMemoryDto, { confirm: false })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(validate(ClearProjectMemoryDto, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('optional flags may still be omitted', async () => {
    const dto = await validate(RetryExecutionDto, { stage: 'AI_FETCH', category: 'NETWORK' });
    expect(dto.writeConfirmed).toBeUndefined();
    expect(dto.idempotentSafe).toBeUndefined();
    expect((await validate(UpdateRepositoryDto, {})).enabled).toBeUndefined();
  });
});
