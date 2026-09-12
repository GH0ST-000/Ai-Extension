import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  PROJECT_MEMORY_CATEGORY_VALUES,
  PROJECT_MEMORY_MAX_SUMMARY_CHARS,
  type ProjectMemoryCategory,
} from '@project-x/types';

export class MemoryScopeDto {
  @IsIn(['repository', 'directory', 'service', 'file-pattern', 'user-project'])
  type!: 'repository' | 'directory' | 'service' | 'file-pattern' | 'user-project';

  @IsOptional()
  @IsString()
  @MaxLength(512)
  path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  pattern?: string;
}

export class CreateProjectMemoryRuleDto {
  @IsIn([...PROJECT_MEMORY_CATEGORY_VALUES])
  category!: ProjectMemoryCategory;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  key?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(PROJECT_MEMORY_MAX_SUMMARY_CHARS)
  text!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MemoryScopeDto)
  @IsObject()
  scope?: MemoryScopeDto;
}
