import { Module } from '@nestjs/common';

import { EntitlementsModule } from '../entitlements/entitlements.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UsageModule } from '../usage/usage.module';
import { BillingService } from './billing.service';
import { PaddleWebhookController } from './paddle-webhook.controller';

@Module({
  imports: [PrismaModule, EntitlementsModule, UsageModule],
  controllers: [PaddleWebhookController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
