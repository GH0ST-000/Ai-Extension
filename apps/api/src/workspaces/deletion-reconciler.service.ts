import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ApiConfig } from '../config/configuration';
import { WorkspaceDeletionService } from './workspace-deletion.service';

const RECONCILE_INTERVAL_MS = 5 * 60_000;

/**
 * N-2/N-3: periodic recovery for workspace deletion and billing cancellation, in every API
 * instance (same pattern as the usage sweeper: in-process, unref'd, idempotent and safe to
 * overlap — each cancellation request is claimed with a lease). Retries failed provider
 * cancellations with backoff and finalizes pending deletions once billing is confirmed.
 * Disabled under NODE_ENV=test (tests call reconcile() directly).
 */
@Injectable()
export class DeletionReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeletionReconcilerService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly deletion: WorkspaceDeletionService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  onModuleInit(): void {
    if (this.config.get('nodeEnv', { infer: true }) === 'test') return;
    this.timer = setInterval(() => {
      void this.deletion.reconcile().catch((error: unknown) =>
        this.logger.warn({
          msg: 'workspace.deletion.reconcile_pass_failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }, RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
