import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import type { MultiRepoRepositoryRole, MultiRepoRepositorySource } from '@project-x/types';

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

const SOURCE_VALUES = [
  'user_selected',
  'project_memory',
  'deterministic_link',
] as const satisfies readonly MultiRepoRepositorySource[];

export class AddRepositoryDto {
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

  @IsOptional()
  @IsIn([...SOURCE_VALUES])
  source?: MultiRepoRepositorySource;
}
