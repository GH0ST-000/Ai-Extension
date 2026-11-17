import { Module } from '@nestjs/common';

import { InternalAnalyticsController } from './internal-analytics.controller';
import { ProductAnalyticsService } from './product-analytics.service';

@Module({
  controllers: [InternalAnalyticsController],
  providers: [ProductAnalyticsService],
})
export class AnalyticsModule {}
