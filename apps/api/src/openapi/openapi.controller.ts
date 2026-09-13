import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { RateLimit, RateLimitGuard } from '../common/security/rate-limit.guard';
import {
  OpenApiDiffDto,
  OpenApiExampleDto,
  OpenApiRisksDto,
  ParseOpenApiContentDto,
  ParseOpenApiUrlDto,
} from './dto/openapi.dto';
import { OpenApiDocumentService } from './openapi-document.service';

@Controller('openapi')
@UseGuards(JwtAuthGuard, RateLimitGuard)
export class OpenApiController {
  constructor(private readonly documents: OpenApiDocumentService) {}

  @Post('parse-url')
  @RateLimit({ bucket: 'openapi', limit: 20, windowSeconds: 60 })
  parseUrl(@CurrentUser() _user: AuthRequestUser, @Body() body: ParseOpenApiUrlDto) {
    return this.documents.parseFromUrl(body.url);
  }

  @Post('parse-content')
  parseContent(@CurrentUser() _user: AuthRequestUser, @Body() body: ParseOpenApiContentDto) {
    return this.documents.parseFromContent(body.content, body.sourceUrl);
  }

  @Post('example')
  example(@CurrentUser() _user: AuthRequestUser, @Body() body: OpenApiExampleDto) {
    const contract = this.documents.parseFromContent(body.content, body.sourceUrl);
    return this.documents.exampleFor(contract, body.operation);
  }

  @Post('risks')
  risks(@CurrentUser() _user: AuthRequestUser, @Body() body: OpenApiRisksDto) {
    const contract = this.documents.parseFromContent(body.content, body.sourceUrl);
    const result = this.documents.deterministicRisks(
      contract,
      body.scope,
      body.operation,
      body.tag,
    );
    return {
      overview: `Deterministic contract scan over ${body.scope} scope.`,
      riskLevel: result.riskLevel,
      findings: result.findings,
      openQuestions: result.openQuestions,
      scope: body.scope,
      documentHash: contract.documentHash,
    };
  }

  @Post('diff')
  diff(@CurrentUser() _user: AuthRequestUser, @Body() body: OpenApiDiffDto) {
    const base = this.documents.parseFromContent(body.baseContent);
    const head = this.documents.parseFromContent(body.headContent);
    return this.documents.diff(base, head, {
      baseRef: body.baseRef,
      headRef: body.headRef,
    });
  }
}
