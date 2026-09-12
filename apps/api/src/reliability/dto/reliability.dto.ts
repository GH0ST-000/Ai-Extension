import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const TRIGGERS = ['user', 'retry', 'resume', 'replay'] as const;
const AUDIT_TYPES = [
  'WORKFLOW_STARTED',
  'WORKFLOW_COMPLETED',
  'WORKFLOW_FAILED',
  'WORKFLOW_CANCELLED',
  'PLANNING_STARTED',
  'PLANNING_COMPLETED',
  'ARTIFACT_CREATED',
  'AI_REQUEST_STARTED',
  'AI_REQUEST_COMPLETED',
  'AI_REQUEST_FAILED',
  'GITHUB_WRITE_CONFIRMED',
  'GITHUB_WRITE_COMPLETED',
  'PATCH_GENERATED',
  'PATCH_APPLIED',
  'REPLAY_STARTED',
  'REPLAY_COMPLETED',
  'RESUME_STARTED',
  'RESUME_COMPLETED',
  'CHECKPOINT_CREATED',
  'RETRY_STARTED',
  'RETRY_COMPLETED',
  'CONTEXT_LOADED',
  'FAILURE_RECORDED',
] as const;

const CHECKPOINT_KINDS = [
  'PLANNING_COMPLETE',
  'GITHUB_CONTEXT_LOADED',
  'OPENAPI_LOADED',
  'PROJECT_MEMORY_LOADED',
  'MULTI_REPO_LOADED',
  'PR_PARSED',
  'AI_SUMMARY_COMPLETE',
  'PATCH_GENERATED',
  'JIRA_LOADED',
  'CUSTOM',
] as const;

const COMPLETE_STATUSES = ['completed', 'failed', 'cancelled', 'stale'] as const;
const AI_STATUSES = ['started', 'completed', 'failed'] as const;
const RETRY_STAGES = [
  'AI_FETCH',
  'GITHUB_READ',
  'JIRA_READ',
  'OPENAPI_FETCH',
  'GITHUB_WRITE',
  'PATCH_APPLY',
  'REVIEW_SUBMIT',
  'PLANNING',
  'OTHER',
] as const;
const FAILURE_CATEGORIES = [
  'NETWORK',
  'GITHUB',
  'JIRA',
  'OPENAPI',
  'AI_PROVIDER',
  'TIMEOUT',
  'RATE_LIMIT',
  'VALIDATION',
  'STALE_CONTEXT',
  'UNKNOWN',
] as const;

export class StartWorkflowExecutionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  workflowId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  goal!: string;

  @IsOptional()
  @IsIn(TRIGGERS)
  trigger?: (typeof TRIGGERS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(128)
  parentExecutionId?: string;

  @IsOptional()
  @IsObject()
  contextVersion?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  constraints?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  selectedRepositories?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(128)
  workflowCapability?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  promptName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  promptBody?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  capability?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  action?: string;
}

export class AppendAuditEventDto {
  @IsIn(AUDIT_TYPES)
  type!: (typeof AUDIT_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(128)
  stepId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  artifactId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timestamp?: string;
}

export class CreateCheckpointDto {
  @IsIn(CHECKPOINT_KINDS)
  kind!: (typeof CHECKPOINT_KINDS)[number];

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  stepId?: string;

  @IsOptional()
  @IsObject()
  state?: Record<string, unknown>;
}

export class RecordFailureDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(599)
  httpStatus?: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  stage?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class RecordAiRequestDto {
  @IsIn(AI_STATUSES)
  status!: (typeof AI_STATUSES)[number];

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  provider!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  model!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  capability?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  promptName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  promptBody?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(4_000, { each: true })
  inputParts?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  outputText?: string;

  @IsOptional()
  @IsObject()
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3_600_000)
  durationMs?: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  memoryVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  systemContextVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  openapiVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  jiraVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  workflowFactsVersion?: string;
}

export class ArtifactLineageItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  kind!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  parentArtifactId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  producedByStepId?: string;
}

export class RecordArtifactLineageDto {
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => ArtifactLineageItemDto)
  artifacts!: ArtifactLineageItemDto[];
}

export class CompleteExecutionDto {
  @IsIn(COMPLETE_STATUSES)
  status!: (typeof COMPLETE_STATUSES)[number];

  @IsOptional()
  @IsObject()
  healthSignals?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  snapshotArtifacts?: Array<Record<string, unknown>>;
}

export class ReplayPreviewDto {
  @IsOptional()
  @IsObject()
  currentContext?: Record<string, unknown>;
}

export class RetryExecutionDto {
  @IsIn(RETRY_STAGES)
  stage!: (typeof RETRY_STAGES)[number];

  @IsIn(FAILURE_CATEGORIES)
  category!: (typeof FAILURE_CATEGORIES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  attempt?: number;

  @IsOptional()
  @IsBoolean()
  writeConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  idempotentSafe?: boolean;
}
