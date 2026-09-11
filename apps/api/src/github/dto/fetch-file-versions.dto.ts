import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { GITHUB_PATCH_MAX_PATH_CHARACTERS } from '@project-x/types';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** Day 18 — fetch one path at two commit SHAs (read-only Contents API). */
export class FetchFileVersionsDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(GITHUB_PATCH_MAX_PATH_CHARACTERS)
  path!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[0-9a-fA-F]{7,64}$/, {
    message: 'baseSha must be a git SHA',
  })
  baseSha!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[0-9a-fA-F]{7,64}$/, {
    message: 'headSha must be a git SHA',
  })
  headSha!: string;
}
