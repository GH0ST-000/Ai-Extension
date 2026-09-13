import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { FIRST_VALUE_TYPES, type FirstValueType } from '@project-x/types';

export class UpdateOnboardingDto {
  @IsOptional()
  @IsBoolean()
  welcomeSeen?: boolean;

  @IsOptional()
  @IsBoolean()
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
  @IsBoolean()
  firstWriteEducationSeen?: boolean;
}
