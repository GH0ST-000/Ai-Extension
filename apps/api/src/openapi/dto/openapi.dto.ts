import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { HTTP_METHODS } from '@project-x/types';

export class ParseOpenApiUrlDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url!: string;
}

export class ParseOpenApiContentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1_500_000)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  sourceUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(253)
  pageOrigin?: string;
}

export class OperationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  @IsIn([...HTTP_METHODS])
  method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  operationId?: string;
}

export class OpenApiExampleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1_500_000)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  sourceUrl?: string;

  @ValidateNested()
  @Type(() => OperationQueryDto)
  operation!: OperationQueryDto;
}

export class OpenApiRisksDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1_500_000)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  sourceUrl?: string;

  @IsIn(['operation', 'tag', 'contract'])
  scope!: 'operation' | 'tag' | 'contract';

  @IsOptional()
  @ValidateNested()
  @Type(() => OperationQueryDto)
  operation?: OperationQueryDto;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  tag?: string;
}

export class OpenApiDiffDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1_500_000)
  baseContent!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1_500_000)
  headContent!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  baseRef!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  headRef!: string;
}
