import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { PostPullRequestCommentDto } from './dto/post-pull-request-comment.dto';
import { GithubWriteService } from './github-write.service';

@Controller('github')
@UseGuards(JwtAuthGuard)
export class GithubController {
  constructor(private readonly githubWriteService: GithubWriteService) {}

  @Post('pull-requests/comments')
  postPullRequestComment(
    @CurrentUser() user: AuthRequestUser,
    @Body() body: PostPullRequestCommentDto,
  ) {
    return this.githubWriteService.postPullRequestComment(user.id, body);
  }
}
