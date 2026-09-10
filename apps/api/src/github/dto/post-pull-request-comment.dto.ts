import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class PostPullRequestCommentDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_.-]+$/, {
    message: 'owner must be a valid GitHub login/org name',
  })
  owner!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_.-]+$/, {
    message: 'repository must be a valid GitHub repo name',
  })
  repository!: string;

  @IsInt()
  @Min(1)
  @Max(10_000_000)
  pullRequestNumber!: number;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'body must not be empty' })
  @MinLength(1)
  @MaxLength(65_536)
  body!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'idempotencyKey must be alphanumeric (with . : _ -)',
  })
  idempotencyKey!: string;
}
