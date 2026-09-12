import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CompareRequirementDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  systemId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  issueKey!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MaxLength(240, { each: true })
  @Type(() => String)
  criteria?: string[];
}
