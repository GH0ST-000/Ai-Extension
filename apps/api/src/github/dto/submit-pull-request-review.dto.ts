import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  GITHUB_REVIEW_EVENTS,
  GITHUB_REVIEW_MAX_BODY_CHARACTERS,
  GITHUB_REVIEW_MAX_COMMENT_CHARACTERS,
  GITHUB_REVIEW_MAX_COMMENTS,
  type GitHubReviewEvent,
} from '@project-x/types';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class SubmitPullRequestReviewCommentDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'comment body must not be empty' })
  @MinLength(1)
  @MaxLength(GITHUB_REVIEW_MAX_COMMENT_CHARACTERS)
  body!: string;

  @ValidateIf((o: SubmitPullRequestReviewCommentDto) => o.line != null || o.side != null)
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  path?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  line?: number;

  @ValidateIf((o: SubmitPullRequestReviewCommentDto) => o.line != null)
  @IsIn(['LEFT', 'RIGHT'])
  side?: 'LEFT' | 'RIGHT';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  startLine?: number;

  @ValidateIf((o: SubmitPullRequestReviewCommentDto) => o.startLine != null)
  @IsIn(['LEFT', 'RIGHT'])
  startSide?: 'LEFT' | 'RIGHT';
}

export class SubmitPullRequestReviewDto {
  @IsIn([...GITHUB_REVIEW_EVENTS])
  event!: GitHubReviewEvent;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(GITHUB_REVIEW_MAX_BODY_CHARACTERS)
  body?: string;

  @IsArray()
  @ArrayMaxSize(GITHUB_REVIEW_MAX_COMMENTS)
  @ValidateNested({ each: true })
  @Type(() => SubmitPullRequestReviewCommentDto)
  comments!: SubmitPullRequestReviewCommentDto[];

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'clientRequestId must be alphanumeric (with . : _ -)',
  })
  clientRequestId!: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(/^[a-f0-9]{7,64}$/i, {
    message: 'expectedHeadSha must be a git SHA',
  })
  expectedHeadSha?: string;
}
