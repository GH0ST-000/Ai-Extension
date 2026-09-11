import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { OpenApiController } from './openapi.controller';
import { OpenApiDocumentService } from './openapi-document.service';
import { OpenApiErrorNormalizer } from './openapi-error-normalizer';
import { OpenApiFetchService } from './openapi-fetch.service';

@Module({
  imports: [AuthModule],
  controllers: [OpenApiController],
  providers: [OpenApiDocumentService, OpenApiFetchService, OpenApiErrorNormalizer],
  exports: [OpenApiDocumentService],
})
export class OpenApiModule {}
