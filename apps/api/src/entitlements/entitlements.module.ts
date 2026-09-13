import { Global, Module } from '@nestjs/common';

import { EntitlementService } from './entitlements.service';
import { FeatureGate } from './feature-gate';

@Global()
@Module({
  providers: [EntitlementService, FeatureGate],
  exports: [EntitlementService, FeatureGate],
})
export class EntitlementsModule {}
