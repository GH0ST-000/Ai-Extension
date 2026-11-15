import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { FIRST_VALUE_TYPES, type FirstValueType } from '@project-x/types';

import { StrictBoolean } from '../../common/validation/strict-boolean';

export class UpdateOnboardingDto {
  @IsOptional()
  @StrictBoolean()
  welcomeSeen?: boolean;

  @IsOptional()
  @StrictBoolean()
  dismiss?: boolean;

  @IsOptional()
  @IsIn(FIRST_VALUE_TYPES)
  firstValueType?: FirstValueType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  dismissHintId?: string;

  @IsOptional()
  @StrictBoolean()
  firstWriteEducationSeen?: boolean;
}
