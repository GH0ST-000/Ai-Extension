import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { DEFAULT_QUEUE } from './queue.constants';

@Module({
  imports: [
    BullModule.registerQueue({
      name: DEFAULT_QUEUE,
    }),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
