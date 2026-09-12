import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MULTI_REPO_MAX_REPOS_PER_ANALYSIS, type SystemFlowTrigger } from '@project-x/types';

class TraceFlowTriggerDto {
  @IsIn(['http_operation', 'kafka_topic', 'jira', 'code_symbol', 'pull_request', 'unknown'])
  kind!: SystemFlowTrigger['kind'];

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  key!: string;

  @IsOptional()
  @IsObject()
  repository?: { provider?: 'github'; owner: string; repository: string };

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  summary?: string;
}

export class TraceFlowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  systemId!: string;

  @ValidateNested()
  @Type(() => TraceFlowTriggerDto)
  trigger!: TraceFlowTriggerDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MULTI_REPO_MAX_REPOS_PER_ANALYSIS)
  @IsString({ each: true })
  repositoryIds?: string[];
}
