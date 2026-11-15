/**
 * Request contract for `projectMemoryMode` through the production ValidationPipe options
 * (src/main.ts). The bodies below are exactly what the extension's `buildAiRequest` sends
 * (asserted on the extension side in apps/extension/lib/selection/review-memory-mode.spec.ts).
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AIAction } from '@project-x/types';
import { describe, expect, it } from 'vitest';

import { ExecuteAiActionDto } from './execute-ai-action.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const validate = (body: unknown) =>
  pipe.transform(body, {
    type: 'body',
    metatype: ExecuteAiActionDto,
  }) as Promise<ExecuteAiActionDto>;

/** Extension PR review request (buildAiRequest output) with the given memory setting. */
const extensionReview = (projectMemoryMode?: unknown) => ({
  action: AIAction.REVIEW_ENTIRE_PR,
  text: 'Review this PR.',
  customPrompt: null,
  targetLanguage: null,
  context: {
    type: 'github',
    url: 'https://github.com/acme/app/pull/48',
    title: 'PR',
    github: { owner: 'acme', repository: 'app', pullRequestNumber: 48 },
  },
  errorIntelligence: null,
  memoryRepository: 'acme/app',
  ...(projectMemoryMode !== undefined ? { projectMemoryMode } : {}),
});

describe('ExecuteAiActionDto.projectMemoryMode', () => {
  it.each(['on', 'off'] as const)('accepts %s unchanged', async (mode) => {
    expect((await validate(extensionReview(mode))).projectMemoryMode).toBe(mode);
  });

  it('is optional: older clients that omit it (or send null) stay valid (server default: on)', async () => {
    expect((await validate(extensionReview())).projectMemoryMode).toBeUndefined();
    expect((await validate(extensionReview(null))).projectMemoryMode ?? undefined).toBeUndefined();
  });

  it.each([false, true, 'false', 'OFF', 'On', 'disabled', '', 0, 1, {}, []])(
    'rejects %j (only the strings "on" / "off")',
    async (mode) => {
      await expect(validate(extensionReview(mode))).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('off without memoryRepository is still an explicit off (no reliance on that field)', async () => {
    const { memoryRepository: _omit, ...body } = extensionReview('off');
    const dto = await validate(body);
    expect(dto.projectMemoryMode).toBe('off');
    expect(dto.memoryRepository).toBeUndefined();
  });
});
