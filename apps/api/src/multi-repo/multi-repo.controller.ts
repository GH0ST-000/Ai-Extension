import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  DiscoverRelationshipsResponse,
  MultiRepoArchitectureContext,
  MultiRepoChangeImpactAnalysis,
  MultiRepoRequirementCoverage,
  ProjectSystem,
  RepositoryIdentity,
  RepositoryRelationship,
  SystemFlowTrace,
} from '@project-x/types';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { ResolvedWorkspacePermissionGuard } from '../workspaces/resolved-workspace-permission.guard';
import { RequireWorkspacePermission } from '../workspaces/workspace.decorators';
import { RateLimit, RateLimitGuard } from '../common/security/rate-limit.guard';
import { AddRepositoryDto } from './dto/add-repository.dto';
import { AnalyzeImpactDto } from './dto/analyze-impact.dto';
import { CompareRequirementDto } from './dto/compare-requirement.dto';
import { CreateSystemDto } from './dto/create-system.dto';
import { TraceFlowDto } from './dto/trace-flow.dto';
import { UpdateRepositoryDto } from './dto/update-repository.dto';
import { UpdateSystemDto } from './dto/update-system.dto';
import { MultiRepoService } from './multi-repo.service';

class FindApiConsumersDto {
  @IsOptional()
  @IsString()
  @MaxLength(16)
  method?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  path!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  operationId?: string;
}

class FindEventConsumersDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  topic!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  eventType?: string;
}

class ContextQueryDto {
  @IsOptional()
  @IsString({ each: true })
  repositoryKeys?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  maxRepos?: number;
}

/**
 * Systems API. M4: every route declares its workspace permission and is checked by
 * ResolvedWorkspacePermissionGuard before the handler runs (active membership, active
 * workspace, permission). The service re-checks the same permission for internal callers.
 *
 * systems:read   — reads, analyses and the caller's own discovery (Discover/Refresh store only
 *                  the caller's user-scoped findings, never shared configuration).
 * systems:manage — creating/updating/deleting systems and changing repository associations.
 */
/**
 * N-9: abuse protection for the charged, GitHub-heavy analyses that every role may run
 * (systems:read). Per user AND per workspace; checked after authorization and before any
 * GitHub call or usage reservation (plan quota is still enforced atomically by usage).
 */
const SYSTEMS_SCAN_LIMIT = {
  bucket: 'systems_scan',
  limit: 10,
  windowSeconds: 60 * 60,
  perWorkspaceLimit: 40,
};
const SYSTEMS_ANALYZE_LIMIT = {
  bucket: 'systems_analyze',
  limit: 20,
  windowSeconds: 60 * 60,
  perWorkspaceLimit: 80,
};

@Controller('systems')
@UseGuards(JwtAuthGuard, ResolvedWorkspacePermissionGuard)
export class MultiRepoController {
  constructor(private readonly multiRepo: MultiRepoService) {}

  @Get()
  @RequireWorkspacePermission('systems:read')
  list(@CurrentUser() user: AuthRequestUser): Promise<ProjectSystem[]> {
    return this.multiRepo.listSystems(user.id);
  }

  @Post()
  @RequireWorkspacePermission('systems:manage')
  create(
    @CurrentUser() user: AuthRequestUser,
    @Body() body: CreateSystemDto,
  ): Promise<ProjectSystem> {
    return this.multiRepo.createSystem(user.id, body);
  }

  @Get(':systemId')
  @RequireWorkspacePermission('systems:read')
  get(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
  ): Promise<ProjectSystem> {
    return this.multiRepo.getSystem(user.id, systemId);
  }

  @Patch(':systemId')
  @RequireWorkspacePermission('systems:manage')
  update(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Body() body: UpdateSystemDto,
  ): Promise<ProjectSystem> {
    return this.multiRepo.updateSystem(user.id, systemId, body);
  }

  @Delete(':systemId')
  @RequireWorkspacePermission('systems:manage')
  delete(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
  ): Promise<{ deleted: true; id: string }> {
    return this.multiRepo.deleteSystem(user.id, systemId);
  }

  @Post(':systemId/repositories')
  @RequireWorkspacePermission('systems:manage')
  addRepository(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Body() body: AddRepositoryDto,
  ): Promise<ProjectSystem> {
    return this.multiRepo.addRepository(user.id, systemId, body);
  }

  @Patch(':systemId/repositories/:owner/:repo')
  @RequireWorkspacePermission('systems:manage')
  updateRepository(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Body() body: UpdateRepositoryDto,
  ): Promise<ProjectSystem> {
    return this.multiRepo.updateRepository(user.id, systemId, owner, repo, body);
  }

  @Delete(':systemId/repositories/:owner/:repo')
  @RequireWorkspacePermission('systems:manage')
  removeRepository(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
  ): Promise<ProjectSystem> {
    return this.multiRepo.removeRepository(user.id, systemId, owner, repo);
  }

  @Post(':systemId/refresh')
  @UseGuards(RateLimitGuard)
  @RateLimit(SYSTEMS_SCAN_LIMIT)
  @RequireWorkspacePermission('systems:read')
  refresh(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
  ): Promise<{
    analyzed: number;
    relationshipsChecked: number;
    candidates: unknown[];
    unavailable: RepositoryIdentity[];
    truncated: boolean;
  }> {
    return this.multiRepo.refreshSystemContext(user.id, systemId);
  }

  @Get(':systemId/relationships')
  @RequireWorkspacePermission('systems:read')
  listRelationships(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
  ): Promise<RepositoryRelationship[]> {
    return this.multiRepo.listRelationships(user.id, systemId);
  }

  @Post(':systemId/relationships/discover')
  @UseGuards(RateLimitGuard)
  @RateLimit(SYSTEMS_SCAN_LIMIT)
  @RequireWorkspacePermission('systems:read')
  discover(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
  ): Promise<DiscoverRelationshipsResponse> {
    return this.multiRepo.discoverRelationships(user.id, systemId);
  }

  @Get(':systemId/context')
  @RequireWorkspacePermission('systems:read')
  context(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Query() query: ContextQueryDto,
  ): Promise<MultiRepoArchitectureContext> {
    return this.multiRepo.buildArchitectureContext(user.id, systemId, {
      repositoryKeys: query.repositoryKeys,
      maxRepos: query.maxRepos,
    });
  }

  @Post(':systemId/analyze-change-impact')
  @UseGuards(RateLimitGuard)
  @RateLimit(SYSTEMS_ANALYZE_LIMIT)
  @RequireWorkspacePermission('systems:read')
  analyzeImpact(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Body() body: AnalyzeImpactDto,
  ): Promise<MultiRepoChangeImpactAnalysis> {
    return this.multiRepo.analyzeChangeImpact(user.id, { ...body, systemId });
  }

  @Post(':systemId/trace-system-flow')
  @RequireWorkspacePermission('systems:read')
  traceFlow(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Body() body: TraceFlowDto,
  ): Promise<SystemFlowTrace> {
    return this.multiRepo.traceSystemFlow(user.id, {
      systemId,
      trigger: {
        kind: body.trigger.kind,
        key: body.trigger.key,
        ...(body.trigger.summary ? { summary: body.trigger.summary } : {}),
        ...(body.trigger.repository
          ? {
              repository: {
                provider: 'github' as const,
                owner: body.trigger.repository.owner,
                repository: body.trigger.repository.repository,
              },
            }
          : {}),
      },
      repositoryIds: body.repositoryIds,
    });
  }

  @Post(':systemId/compare-requirement')
  @RequireWorkspacePermission('systems:read')
  compareRequirement(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Body() body: CompareRequirementDto,
  ): Promise<MultiRepoRequirementCoverage> {
    return this.multiRepo.compareRequirementAcrossRepos(user.id, {
      systemId,
      issueKey: body.issueKey,
      criteria: body.criteria,
    });
  }

  @Post(':systemId/find-api-consumers')
  @RequireWorkspacePermission('systems:read')
  findApiConsumers(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Body() body: FindApiConsumersDto,
  ) {
    return this.multiRepo.findApiConsumers(user.id, systemId, body);
  }

  @Post(':systemId/find-event-consumers')
  @RequireWorkspacePermission('systems:read')
  findEventConsumers(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Body() body: FindEventConsumersDto,
  ) {
    return this.multiRepo.findEventConsumers(user.id, systemId, body);
  }
}
