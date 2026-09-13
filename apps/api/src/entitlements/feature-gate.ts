import { Injectable } from '@nestjs/common';
import type { ProductFeature } from '@project-x/types';

import { EntitlementService } from './entitlements.service';

/**
 * Thin feature-gate helper for controllers/services.
 */
@Injectable()
export class FeatureGate {
  constructor(private readonly entitlements: EntitlementService) {}

  require(workspaceId: string, feature: ProductFeature): Promise<void> {
    return this.entitlements.assertFeature(workspaceId, feature);
  }

  /** Alias used by AI and other gated call sites. */
  assert(workspaceId: string, feature: ProductFeature): Promise<void> {
    return this.require(workspaceId, feature);
  }
}
