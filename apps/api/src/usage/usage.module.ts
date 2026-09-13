import { Global, Module } from '@nestjs/common';

import { EntitlementsModule } from '../entitlements/entitlements.module';
import { UsageService } from './usage.service';

@Global()
@Module({
  imports: [EntitlementsModule],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
