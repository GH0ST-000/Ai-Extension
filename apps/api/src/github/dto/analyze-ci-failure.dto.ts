import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class AnalyzeCiChangedFileDto {
  @IsString()
  @MaxLength(512)
  path!: string;
}

export class AnalyzeCiFailureDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  expectedHeadSha?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => AnalyzeCiChangedFileDto)
  changedFiles?: AnalyzeCiChangedFileDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  pullRequestTitle?: string;
}
