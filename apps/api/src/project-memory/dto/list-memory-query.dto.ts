import { IsIn, IsOptional, IsString } from 'class-validator';

export class ListProjectMemoryQueryDto {
  @IsOptional()
  @IsIn(['active', 'superseded', 'disputed', 'archived'])
  status?: 'active' | 'superseded' | 'disputed' | 'archived';
}

export class ProjectMemorySummaryQueryDto {
  @IsOptional()
  @IsString()
  capability?: string;

  /** Comma-separated path hints */
  @IsOptional()
  @IsString()
  paths?: string;
}
