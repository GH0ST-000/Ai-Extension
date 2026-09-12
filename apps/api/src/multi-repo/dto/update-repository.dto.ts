import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import type { MultiRepoRepositoryRole } from '@project-x/types';

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

export class UpdateRepositoryDto {
  @IsOptional()
  @IsIn([...ROLE_VALUES])
  role?: MultiRepoRepositoryRole;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
