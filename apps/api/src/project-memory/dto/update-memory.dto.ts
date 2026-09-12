import { Type } from 'class-transformer';
import { IsIn, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { PROJECT_MEMORY_MAX_SUMMARY_CHARS } from '@project-x/types';

import { MemoryScopeDto } from './create-rule.dto';

export class MemoryValueDto {
  @IsString()
  @MaxLength(PROJECT_MEMORY_MAX_SUMMARY_CHARS)
  summary!: string;

  @IsOptional()
  @IsObject()
  details?: Record<string, unknown>;
}

export class UpdateProjectMemoryDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => MemoryValueDto)
  value?: MemoryValueDto;

  @IsOptional()
  @IsIn(['active', 'superseded', 'disputed', 'archived'])
  status?: 'active' | 'superseded' | 'disputed' | 'archived';

  @IsOptional()
  @ValidateNested()
  @Type(() => MemoryScopeDto)
  scope?: MemoryScopeDto;

  @IsOptional()
  @IsString()
  @MaxLength(PROJECT_MEMORY_MAX_SUMMARY_CHARS)
  text?: string;
}
