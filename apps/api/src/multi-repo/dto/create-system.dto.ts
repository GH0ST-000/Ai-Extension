import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MULTI_REPO_MAX_REPOS_PER_SYSTEM, type MultiRepoRepositoryRole } from '@project-x/types';

const ROLE_VALUES = [
  'frontend',
  'backend',
  'gateway',
  'worker',
  'shared-contract',
  'library',
  'infrastructure',
  'unknown',
] as const satisfies readonly MultiRepoRepositoryRole[];

export class CreateSystemRepositoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  owner!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  repository!: string;

  @IsOptional()
  @IsIn([...ROLE_VALUES])
  role?: MultiRepoRepositoryRole;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class CreateSystemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  primaryOwner!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  primaryRepository!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MULTI_REPO_MAX_REPOS_PER_SYSTEM)
  @ValidateNested({ each: true })
  @Type(() => CreateSystemRepositoryDto)
  repositories?: CreateSystemRepositoryDto[];
}
