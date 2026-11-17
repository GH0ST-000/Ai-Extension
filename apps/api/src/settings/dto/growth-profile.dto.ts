import { IsIn, ValidateIf } from 'class-validator';
import {
  PRIMARY_GOALS,
  PROFESSIONAL_ROLES,
  USAGE_INTENTS,
  type PrimaryGoal,
  type ProfessionalRole,
  type UsageIntent,
} from '@project-x/types';

import { StrictBoolean } from '../../common/validation/strict-boolean';

/** Partial update: omitted = unchanged, `null` = clear. Only known enum values are accepted. */
export class UpdateGrowthProfileDto {
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsIn(PROFESSIONAL_ROLES)
  professionalRole?: ProfessionalRole | null;

  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsIn(USAGE_INTENTS)
  usageIntent?: UsageIntent | null;

  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsIn(PRIMARY_GOALS)
  primaryGoal?: PrimaryGoal | null;
}

export class UpdateMarketingConsentDto {
  @StrictBoolean()
  granted!: boolean;
}
