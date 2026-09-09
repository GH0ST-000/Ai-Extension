import {
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  IsEnum,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { AIAction, PAGE_CONTEXT_TYPES } from '@project-x/types';

import {
  AI_DEFAULT_MAX_CHANGED_FILE_EXCERPT_CHARACTERS,
  AI_DEFAULT_MAX_CHANGED_FILES,
  AI_DEFAULT_MAX_CONTEXT_CODE_CHARACTERS,
  AI_DEFAULT_MAX_CONTEXT_DESCRIPTION_CHARACTERS,
  AI_DEFAULT_MAX_CONTEXT_PATH_CHARACTERS,
  AI_DEFAULT_MAX_CONTEXT_PR_BODY_CHARACTERS,
  AI_DEFAULT_MAX_CONTEXT_SURROUNDING_CHARACTERS,
  AI_DEFAULT_MAX_CONTEXT_TITLE_CHARACTERS,
  AI_DEFAULT_MAX_CONTEXT_URL_CHARACTERS,
  AI_DEFAULT_MAX_CUSTOM_PROMPT_CHARACTERS,
  AI_DEFAULT_MAX_INPUT_CHARACTERS,
} from '../constants/ai.constants';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function emptyToNull({ value }: { value: unknown }): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  return value;
}

function emptyObjectToUndefined({ value }: { value: unknown }): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
    return undefined;
  }
  return value;
}

export class PageContextPageMetaDto {
  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(AI_DEFAULT_MAX_CONTEXT_DESCRIPTION_CHARACTERS)
  description?: string | null;
}

export class PageContextCodeDto {
  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  language?: string | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(AI_DEFAULT_MAX_CONTEXT_PATH_CHARACTERS)
  fileName?: string | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(AI_DEFAULT_MAX_CONTEXT_CODE_CHARACTERS)
  surroundingCode?: string | null;
}

export class PageContextChangedFileDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(AI_DEFAULT_MAX_CONTEXT_PATH_CHARACTERS)
  path!: string;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(AI_DEFAULT_MAX_CHANGED_FILE_EXCERPT_CHARACTERS)
  patchExcerpt?: string | null;
}

export class PageContextGitHubDto {
  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(128)
  owner?: string | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(128)
  repository?: string | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(256)
  branch?: string | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(AI_DEFAULT_MAX_CONTEXT_PATH_CHARACTERS)
  filePath?: string | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(AI_DEFAULT_MAX_CONTEXT_TITLE_CHARACTERS)
  pullRequestTitle?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  pullRequestNumber?: number | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(AI_DEFAULT_MAX_CONTEXT_PR_BODY_CHARACTERS)
  pullRequestBody?: string | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(256)
  baseBranch?: string | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(256)
  headBranch?: string | null;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PageContextChangedFileDto)
  @ArrayMaxSize(AI_DEFAULT_MAX_CHANGED_FILES)
  changedFiles?: PageContextChangedFileDto[];

  @IsOptional()
  @IsBoolean()
  changedFilesTruncated?: boolean | null;

  @IsOptional()
  @IsBoolean()
  filesTab?: boolean | null;
}

export class PageContextDto {
  @IsIn([...PAGE_CONTEXT_TYPES], {
    message: 'context.type must be generic or github',
  })
  type!: (typeof PAGE_CONTEXT_TYPES)[number];

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(AI_DEFAULT_MAX_CONTEXT_URL_CHARACTERS)
  url!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(AI_DEFAULT_MAX_CONTEXT_TITLE_CHARACTERS)
  title!: string;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(AI_DEFAULT_MAX_CONTEXT_SURROUNDING_CHARACTERS)
  surroundingText?: string | null;

  @Transform(emptyObjectToUndefined)
  @IsOptional()
  @ValidateNested()
  @Type(() => PageContextPageMetaDto)
  page?: PageContextPageMetaDto;

  @Transform(emptyObjectToUndefined)
  @IsOptional()
  @ValidateNested()
  @Type(() => PageContextCodeDto)
  code?: PageContextCodeDto;

  @Transform(emptyObjectToUndefined)
  @IsOptional()
  @ValidateNested()
  @Type(() => PageContextGitHubDto)
  github?: PageContextGitHubDto;
}

export class ExecuteAiActionDto {
  @IsEnum(AIAction, { message: 'action must be a supported AI action' })
  action!: AIAction;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'text must not be empty' })
  @MaxLength(AI_DEFAULT_MAX_INPUT_CHARACTERS, {
    message: `text must be at most ${AI_DEFAULT_MAX_INPUT_CHARACTERS} characters`,
  })
  text!: string;

  /**
   * Required (non-empty) when action is CUSTOM. Optional otherwise.
   * Avoid `@IsOptional` here — it would skip validators when the field is omitted.
   */
  @Transform(emptyToNull)
  @ValidateIf(
    (dto: ExecuteAiActionDto) => dto.action === AIAction.CUSTOM || dto.customPrompt != null,
  )
  @IsString()
  @IsNotEmpty({ message: 'customPrompt is required for CUSTOM actions' })
  @MaxLength(AI_DEFAULT_MAX_CUSTOM_PROMPT_CHARACTERS, {
    message: `customPrompt must be at most ${AI_DEFAULT_MAX_CUSTOM_PROMPT_CHARACTERS} characters`,
  })
  customPrompt?: string | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetLanguage?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => PageContextDto)
  context?: PageContextDto | null;
}
