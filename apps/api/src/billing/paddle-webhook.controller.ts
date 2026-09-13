import { Controller, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { BillingService } from './billing.service';

@Controller('webhooks')
export class PaddleWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post('paddle')
  async paddle(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('paddle-signature') paddleSignature?: string,
    @Headers('x-paddle-signature') xSignature?: string,
  ) {
    const raw =
      req.rawBody ??
      (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {})));
    return this.billing.handleWebhook(raw, paddleSignature ?? xSignature);
  }
}
