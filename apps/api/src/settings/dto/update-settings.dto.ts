import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { RESPONSE_STYLES, type ResponseStyle } from '@project-x/types';

export class UpdateSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(150)
  @Max(2000)
  maxOutputTokens?: number;

  @IsOptional()
  @IsIn(RESPONSE_STYLES)
  responseStyle?: ResponseStyle;

  @IsOptional()
  @IsBoolean()
  includePageContext?: boolean;
}
