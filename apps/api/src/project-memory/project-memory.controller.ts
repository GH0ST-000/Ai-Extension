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
  LearnProjectMemoryResponse,
  ListProjectMemoryResponse,
  ProjectMemoryItem,
  ProjectMemoryScope,
  ProjectMemorySummary,
  ProjectProfile,
} from '@project-x/types';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { ClearProjectMemoryDto } from './dto/clear-memory.dto';
import { MemoryCandidateActionDto } from './dto/candidate-action.dto';
import { CreateProjectMemoryRuleDto } from './dto/create-rule.dto';
import {
  ListProjectMemoryQueryDto,
  ProjectMemorySummaryQueryDto,
} from './dto/list-memory-query.dto';
import { UpdateProjectMemoryDto } from './dto/update-memory.dto';
import { ProjectMemoryService } from './project-memory.service';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectMemoryController {
  constructor(private readonly projectMemory: ProjectMemoryService) {}

  @Get(':owner/:repo/memory')
  list(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query() query: ListProjectMemoryQueryDto,
  ): Promise<ListProjectMemoryResponse> {
    return this.projectMemory.list(user.id, owner, repo, query.status);
  }

  @Get(':owner/:repo/memory/profile')
  profile(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
  ): Promise<ProjectProfile> {
    return this.projectMemory.getProfile(user.id, owner, repo);
  }

  @Get(':owner/:repo/memory/summary')
  summary(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query() query: ProjectMemorySummaryQueryDto,
  ): Promise<ProjectMemorySummary> {
    return this.projectMemory.getSummary(user.id, owner, repo, query.capability, query.paths);
  }

  @Post(':owner/:repo/memory/rules')
  createRule(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Body() body: CreateProjectMemoryRuleDto,
  ): Promise<ProjectMemoryItem> {
    return this.projectMemory.createRule(user.id, owner, repo, {
      category: body.category,
      key: body.key,
      text: body.text,
      scope: body.scope as ProjectMemoryScope | undefined,
    });
  }

  @Patch(':owner/:repo/memory/:memoryId')
  update(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('memoryId') memoryId: string,
    @Body() body: UpdateProjectMemoryDto,
  ): Promise<ProjectMemoryItem> {
    return this.projectMemory.update(user.id, owner, repo, memoryId, {
      value: body.value,
      status: body.status,
      scope: body.scope as ProjectMemoryScope | undefined,
      text: body.text,
    });
  }

  @Delete(':owner/:repo/memory/:memoryId')
  archive(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('memoryId') memoryId: string,
  ): Promise<{ archived: true; id: string }> {
    return this.projectMemory.archive(user.id, owner, repo, memoryId);
  }

  @Post(':owner/:repo/memory/clear')
  clear(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Body() body: ClearProjectMemoryDto,
  ): Promise<{ archived: number }> {
    return this.projectMemory.clear(user.id, owner, repo, body.confirm);
  }

  @Post(':owner/:repo/memory/learn')
  learn(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
  ): Promise<LearnProjectMemoryResponse> {
    return this.projectMemory.learn(user.id, owner, repo);
  }

  @Post(':owner/:repo/memory/candidates/confirm')
  confirmCandidate(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Body() body: MemoryCandidateActionDto,
  ): Promise<ProjectMemoryItem> {
    return this.projectMemory.confirmCandidate(user.id, owner, repo, body.candidateId);
  }

  @Post(':owner/:repo/memory/candidates/reject')
  rejectCandidate(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Body() body: MemoryCandidateActionDto,
  ): Promise<{ rejected: true; candidateId: string }> {
    return this.projectMemory.rejectCandidate(user.id, owner, repo, body.candidateId);
  }
}
