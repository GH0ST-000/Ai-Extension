import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ResponseStyle } from '@prisma/client';

export class UpdateSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(150)
  @Max(2000)
  maxOutputTokens?: number;

  @IsOptional()
  @IsEnum(ResponseStyle)
  responseStyle?: ResponseStyle;

  @IsOptional()
  @IsBoolean()
  includePageContext?: boolean;
}
