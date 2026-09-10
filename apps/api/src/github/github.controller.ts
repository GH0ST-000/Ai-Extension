import { Body, Controller, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { PostPullRequestCommentDto } from './dto/post-pull-request-comment.dto';
import { SubmitPullRequestReviewDto } from './dto/submit-pull-request-review.dto';
import { GithubReviewService } from './github-review.service';
import { GithubWriteService } from './github-write.service';

@Controller('github')
@UseGuards(JwtAuthGuard)
export class GithubController {
  constructor(
    private readonly githubWriteService: GithubWriteService,
    private readonly githubReviewService: GithubReviewService,
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
}
