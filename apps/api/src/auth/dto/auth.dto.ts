import { IsEmail, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { StrictBoolean } from '../../common/validation/strict-boolean';
import { Transform } from 'class-transformer';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class RegisterDto {
  @Transform(trimString)
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  /** Optional marketing email consent — unchecked by default, never required. */
  @IsOptional()
  @StrictBoolean()
  marketingConsent?: boolean;

  /**
   * Optional first-touch attribution. Accepted as an object and sanitized server-side
   * (invalid values are dropped, never rejected) so it can never block account creation.
   */
  @IsOptional()
  @IsObject()
  attribution?: Record<string, unknown>;
}

export class LoginDto {
  @Transform(trimString)
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  refreshToken?: string;
}

/** Same email normalization as registration (trim here, lowercase in the service). */
export class PasswordResetRequestDto {
  @Transform(trimString)
  @IsEmail()
  @MaxLength(255)
  email!: string;
}

/** Decision A: the verification token from the link fragment. */
export class EmailVerificationConfirmDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token!: string;
}

/** Same password rules as registration. */
export class PasswordResetConfirmDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}
