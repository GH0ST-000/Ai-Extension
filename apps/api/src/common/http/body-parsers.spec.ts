import { Body, Controller, Post, Req } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyBodyParsers } from './body-parsers';

/** Echoes what the production body parsing hands to a handler (e.g. a webhook). */
@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() body: unknown, @Req() req: Request & { rawBody?: Buffer }) {
    return { body: body ?? null, rawBody: req.rawBody?.toString('utf8') ?? null };
  }
}

describe('applyBodyParsers (production body parsing)', () => {
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [EchoController] }).compile();
    // Same as main.ts: Nest's default parsers off, ours on.
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      rawBody: true,
      logger: false,
    });
    applyBodyParsers(app, 1_000_000);
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => app?.close());

  const post = async (body: string, contentType: string) =>
    (await (
      await fetch(`${base}/echo`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      })
    ).json()) as { body: Record<string, unknown> | null; rawBody: string | null };

  it('parses JSON and keeps the exact raw bytes for webhook signatures', async () => {
    const payload = '{"event_type":"subscription.updated","data":{"id":"sub_1"}}';
    const result = await post(payload, 'application/json');
    expect(result.body).toEqual({ event_type: 'subscription.updated', data: { id: 'sub_1' } });
    expect(result.rawBody).toBe(payload);
  });

  it('does not parse form-encoded or text/plain bodies (no form can fill a DTO)', async () => {
    for (const [body, type] of [
      ['email=a%40b.c&password=secret', 'application/x-www-form-urlencoded'],
      ['email=a@b.c', 'text/plain'],
    ] as const) {
      const result = await post(body, type);
      expect(result.body === null || Object.keys(result.body).length === 0).toBe(true);
      expect(result.rawBody).toBeNull();
    }
  });
});
