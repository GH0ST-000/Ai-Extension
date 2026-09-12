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

@Controller('systems')
@UseGuards(JwtAuthGuard)
export class MultiRepoController {
  constructor(private readonly multiRepo: MultiRepoService) {}

  @Get()
  list(@CurrentUser() user: AuthRequestUser): Promise<ProjectSystem[]> {
    return this.multiRepo.listSystems(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthRequestUser,
    @Body() body: CreateSystemDto,
  ): Promise<ProjectSystem> {
    return this.multiRepo.createSystem(user.id, body);
  }

  @Get(':systemId')
  get(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
  ): Promise<ProjectSystem> {
    return this.multiRepo.getSystem(user.id, systemId);
  }

  @Patch(':systemId')
  update(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Body() body: UpdateSystemDto,
  ): Promise<ProjectSystem> {
    return this.multiRepo.updateSystem(user.id, systemId, body);
  }

  @Delete(':systemId')
  delete(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
  ): Promise<{ deleted: true; id: string }> {
    return this.multiRepo.deleteSystem(user.id, systemId);
  }

  @Post(':systemId/repositories')
  addRepository(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Body() body: AddRepositoryDto,
  ): Promise<ProjectSystem> {
    return this.multiRepo.addRepository(user.id, systemId, body);
  }

  @Patch(':systemId/repositories/:owner/:repo')
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
  removeRepository(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
  ): Promise<ProjectSystem> {
    return this.multiRepo.removeRepository(user.id, systemId, owner, repo);
  }

  @Post(':systemId/refresh')
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
  listRelationships(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
  ): Promise<RepositoryRelationship[]> {
    return this.multiRepo.listRelationships(user.id, systemId);
  }

  @Post(':systemId/relationships/discover')
  discover(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
  ): Promise<DiscoverRelationshipsResponse> {
    return this.multiRepo.discoverRelationships(user.id, systemId);
  }

  @Get(':systemId/context')
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
  analyzeImpact(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Body() body: AnalyzeImpactDto,
  ): Promise<MultiRepoChangeImpactAnalysis> {
    return this.multiRepo.analyzeChangeImpact(user.id, { ...body, systemId });
  }

  @Post(':systemId/trace-system-flow')
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
  findApiConsumers(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Body() body: FindApiConsumersDto,
  ) {
    return this.multiRepo.findApiConsumers(user.id, systemId, body);
  }

  @Post(':systemId/find-event-consumers')
  findEventConsumers(
    @CurrentUser() user: AuthRequestUser,
    @Param('systemId') systemId: string,
    @Body() body: FindEventConsumersDto,
  ) {
    return this.multiRepo.findEventConsumers(user.id, systemId, body);
  }
}
