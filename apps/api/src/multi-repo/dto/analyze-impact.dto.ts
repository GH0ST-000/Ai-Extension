import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MULTI_REPO_MAX_REPOS_PER_ANALYSIS } from '@project-x/types';

export class AnalyzeImpactDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  systemId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  owner!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  repository!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_000_000)
  pullRequestNumber?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  headSha?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MULTI_REPO_MAX_REPOS_PER_ANALYSIS)
  @IsString({ each: true })
  repositoryIds?: string[];
}
