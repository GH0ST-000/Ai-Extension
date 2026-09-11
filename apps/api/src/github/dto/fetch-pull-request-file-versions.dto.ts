import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { GITHUB_PATCH_MAX_PATH_CHARACTERS } from '@project-x/types';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** Day 18 — resolve PR base/head SHAs then fetch one path at both. */
export class FetchPullRequestFileVersionsDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(GITHUB_PATCH_MAX_PATH_CHARACTERS)
  path!: string;
}
