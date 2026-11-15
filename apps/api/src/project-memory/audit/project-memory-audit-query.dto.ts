import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PROJECT_MEMORY_AUDIT_ACTOR_TYPES,
  PROJECT_MEMORY_AUDIT_EVENT_TYPES,
  PROJECT_MEMORY_AUDIT_MAX_LIMIT,
  PROJECT_MEMORY_AUDIT_RULES_MAX_LIMIT,
  PROJECT_MEMORY_AUDIT_SEARCH_MAX_CHARS,
  type ProjectMemoryAuditActorType,
  type ProjectMemoryAuditEventType,
} from '@project-x/types';

/** GitHub owner / repository name characters (no slashes, no path traversal). */
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
/** Server ids (cuid). */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export class ListProjectMemoryAuditQueryDto {
  @IsOptional()
  @IsString()
  @Matches(GITHUB_NAME)
  owner?: string;

  @IsOptional()
  @IsString()
  @Matches(GITHUB_NAME)
  repository?: string;

  @IsOptional()
  @IsString()
  @Matches(ID)
  memoryId?: string;

  @IsOptional()
  @IsIn(PROJECT_MEMORY_AUDIT_EVENT_TYPES)
  eventType?: ProjectMemoryAuditEventType;

  @IsOptional()
  @IsIn(PROJECT_MEMORY_AUDIT_ACTOR_TYPES)
  actorType?: ProjectMemoryAuditActorType;

  @IsOptional()
  @IsString()
  @Matches(ID)
  actorUserId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROJECT_MEMORY_AUDIT_MAX_LIMIT)
  limit?: number;
}

/** Grouped view: one row per rule. Same filters as the event list, plus key search. */
export class ListProjectMemoryAuditRulesQueryDto {
  @IsOptional()
  @IsString()
  @Matches(GITHUB_NAME)
  owner?: string;

  @IsOptional()
  @IsString()
  @Matches(GITHUB_NAME)
  repository?: string;

  @IsOptional()
  @IsIn(PROJECT_MEMORY_AUDIT_EVENT_TYPES)
  eventType?: ProjectMemoryAuditEventType;

  @IsOptional()
  @IsIn(PROJECT_MEMORY_AUDIT_ACTOR_TYPES)
  actorType?: ProjectMemoryAuditActorType;

  @IsOptional()
  @IsString()
  @Matches(ID)
  actorUserId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  /** Substring of the rule key (matched literally, case-insensitive). */
  @IsOptional()
  @IsString()
  @MaxLength(PROJECT_MEMORY_AUDIT_SEARCH_MAX_CHARS)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROJECT_MEMORY_AUDIT_RULES_MAX_LIMIT)
  limit?: number;
}
