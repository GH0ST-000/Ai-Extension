import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class VerifyGithubAppInstallDto {
  /** GitHub user-authorization code from the Callback URL. */
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  code!: string;

  /** Verification state issued by the setup step (48 hex characters). */
  @IsString()
  @Matches(/^[a-f0-9]{48}$/)
  state!: string;
}
