import { IsIn, IsOptional } from 'class-validator';
import type { MultiRepoRepositoryRole } from '@project-x/types';

import { StrictBoolean } from '../../common/validation/strict-boolean';

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
  @StrictBoolean()
  enabled?: boolean;
}
