import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { AnalyzeCiFailureDto } from './dto/analyze-ci-failure.dto';
import { PostPullRequestCommentDto } from './dto/post-pull-request-comment.dto';
import {
  ApplyPullRequestPatchDto,
  PreparePullRequestPatchDto,
} from './dto/prepare-apply-patch.dto';
import { SubmitPullRequestReviewDto } from './dto/submit-pull-request-review.dto';
import { GithubCiService } from './github-ci.service';
import { GithubPatchService } from './github-patch.service';
import { GithubReviewService } from './github-review.service';
import { GithubWriteService } from './github-write.service';

@Controller('github')
@UseGuards(JwtAuthGuard)
export class GithubController {
  constructor(
    private readonly githubWriteService: GithubWriteService,
    private readonly githubReviewService: GithubReviewService,
    private readonly githubPatchService: GithubPatchService,
    private readonly githubCiService: GithubCiService,
  ) {}

  @Post('pull-requests/comments')
  postPullRequestComment(
    @CurrentUser() user: AuthRequestUser,
    @Body() body: PostPullRequestCommentDto,
  ) {
    return this.githubWriteService.postPullRequestComment(user.id, body);
  }

  @Post('pull-requests/:owner/:repo/:number/reviews')
  submitPullRequestReview(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number', ParseIntPipe) number: number,
    @Body() body: SubmitPullRequestReviewDto,
  ) {
    return this.githubReviewService.submitPullRequestReview(user.id, owner, repo, number, body);
  }

  @Post('pull-requests/:owner/:repo/:number/patches/prepare')
  preparePullRequestPatch(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number', ParseIntPipe) number: number,
    @Body() body: PreparePullRequestPatchDto,
  ) {
    return this.githubPatchService.preparePullRequestPatch(user.id, owner, repo, number, body);
  }

  @Post('pull-requests/:owner/:repo/:number/patches/apply')
  applyPullRequestPatch(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number', ParseIntPipe) number: number,
    @Body() body: ApplyPullRequestPatchDto,
  ) {
    return this.githubPatchService.applyPullRequestPatch(user.id, owner, repo, number, body);
  }

  @Get('pull-requests/:owner/:repo/:number/checks')
  listPullRequestChecks(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number', ParseIntPipe) number: number,
  ) {
    return this.githubCiService.listPullRequestChecks(user.id, owner, repo, number);
  }

  @Get('pull-requests/:owner/:repo/:number/checks/:checkId')
  getCheckFailureEvidence(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number', ParseIntPipe) number: number,
    @Param('checkId') checkId: string,
  ) {
    return this.githubCiService.getCheckFailureEvidence(
      user.id,
      owner,
      repo,
      number,
      decodeURIComponent(checkId),
    );
  }

  @Post('pull-requests/:owner/:repo/:number/checks/:checkId/analyze')
  analyzeCheckFailure(
    @CurrentUser() user: AuthRequestUser,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number', ParseIntPipe) number: number,
    @Param('checkId') checkId: string,
    @Body() body: AnalyzeCiFailureDto,
  ) {
    return this.githubCiService.analyzeCheckFailure(
      user.id,
      owner,
      repo,
      number,
      decodeURIComponent(checkId),
      body,
    );
  }
}
