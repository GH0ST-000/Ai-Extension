import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ReliabilityController } from './reliability.controller';
import { ReliabilityService } from './reliability.service';

@Module({
  imports: [AuthModule],
  controllers: [ReliabilityController],
  providers: [ReliabilityService],
  exports: [ReliabilityService],
})
export class ReliabilityModule {}
