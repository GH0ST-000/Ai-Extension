import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class UpsertGithubConnectionDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'token must not be empty' })
  @MinLength(8)
  @MaxLength(512)
  token!: string;
}
