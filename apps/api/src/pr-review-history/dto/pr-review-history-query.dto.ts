import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { PR_REVIEW_HISTORY_MAX_LIMIT, PR_REVIEW_REPORT_STATUSES } from '@project-x/types';

/** GitHub owner / repository name characters (no slashes, no path traversal). */
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

export class ListPrReviewHistoryQueryDto {
  @IsOptional()
  @IsString()
  @Matches(GITHUB_NAME)
  owner?: string;

  @IsOptional()
  @IsString()
  @Matches(GITHUB_NAME)
  repository?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  pullRequestNumber?: number;

  @IsOptional()
  @IsIn(PR_REVIEW_REPORT_STATUSES)
  status?: (typeof PR_REVIEW_REPORT_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PR_REVIEW_HISTORY_MAX_LIMIT)
  limit?: number;
}

export class LatestPrReviewQueryDto {
  @IsString()
  @Matches(GITHUB_NAME)
  owner!: string;

  @IsString()
  @Matches(GITHUB_NAME)
  repository!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  pullRequestNumber!: number;
}
