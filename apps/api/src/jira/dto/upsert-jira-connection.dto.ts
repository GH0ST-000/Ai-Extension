import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class UpsertJiraConnectionDto {
  @Transform(trimString)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(512)
  apiToken!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  siteHost!: string;
}
