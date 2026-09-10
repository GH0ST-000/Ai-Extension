import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  GITHUB_PATCH_MAX_COMMIT_MESSAGE_CHARACTERS,
  GITHUB_PATCH_MAX_FILE_BYTES,
  GITHUB_PATCH_MAX_PATH_CHARACTERS,
} from '@project-x/types';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class PreparePullRequestPatchDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(GITHUB_PATCH_MAX_PATH_CHARACTERS)
  path!: string;

  @IsString()
  @IsNotEmpty({ message: 'newContent must not be empty' })
  @MaxLength(GITHUB_PATCH_MAX_FILE_BYTES)
  newContent!: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(GITHUB_PATCH_MAX_COMMIT_MESSAGE_CHARACTERS)
  commitMessage?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(128)
  findingId?: string;
}

export class ApplyPullRequestPatchDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'preparedPatchId must be alphanumeric (with . : _ -)',
  })
  preparedPatchId!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'commitMessage must not be empty' })
  @MinLength(1)
  @MaxLength(GITHUB_PATCH_MAX_COMMIT_MESSAGE_CHARACTERS)
  commitMessage!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'clientRequestId must be alphanumeric (with . : _ -)',
  })
  clientRequestId!: string;
}
