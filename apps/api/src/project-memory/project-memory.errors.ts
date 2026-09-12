import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ProjectMemoryErrorBody, ProjectMemoryErrorCode } from '@project-x/types';

export function projectMemoryException(
  code: ProjectMemoryErrorCode,
  message: string,
  details?: Record<string, unknown>,
): HttpException {
  const body: ProjectMemoryErrorBody & { statusCode: number } = {
    code,
    message,
    statusCode: statusForCode(code),
    ...(details ? { details } : {}),
  };

  const status = body.statusCode;
  switch (code) {
    case 'PROJECT_MEMORY_ACCESS_DENIED':
      return new ForbiddenException(body);
    case 'PROJECT_MEMORY_ITEM_NOT_FOUND':
    case 'PROJECT_MEMORY_NOT_INITIALIZED':
    case 'PROJECT_MEMORY_CANDIDATE_INVALID':
      return new NotFoundException(body);
    case 'PROJECT_MEMORY_CONFLICT':
      return new ConflictException(body);
    case 'PROJECT_MEMORY_SOURCE_UNAVAILABLE':
    case 'PROJECT_MEMORY_REFRESH_FAILED':
      return new ServiceUnavailableException(body);
    case 'PROJECT_MEMORY_VALIDATION_FAILED':
    case 'PROJECT_MEMORY_LIMIT_REACHED':
    case 'PROJECT_MEMORY_SECRET_DETECTED':
    case 'PROJECT_MEMORY_EXTRACTION_FAILED':
    case 'PROJECT_MEMORY_STALE':
      return new BadRequestException(body);
    case 'UNKNOWN':
    default:
      return new HttpException(body, status);
  }
}

function statusForCode(code: ProjectMemoryErrorCode): number {
  switch (code) {
    case 'PROJECT_MEMORY_ACCESS_DENIED':
      return HttpStatus.FORBIDDEN;
    case 'PROJECT_MEMORY_ITEM_NOT_FOUND':
    case 'PROJECT_MEMORY_NOT_INITIALIZED':
    case 'PROJECT_MEMORY_CANDIDATE_INVALID':
      return HttpStatus.NOT_FOUND;
    case 'PROJECT_MEMORY_CONFLICT':
      return HttpStatus.CONFLICT;
    case 'PROJECT_MEMORY_SOURCE_UNAVAILABLE':
    case 'PROJECT_MEMORY_REFRESH_FAILED':
      return HttpStatus.SERVICE_UNAVAILABLE;
    case 'PROJECT_MEMORY_VALIDATION_FAILED':
    case 'PROJECT_MEMORY_LIMIT_REACHED':
    case 'PROJECT_MEMORY_SECRET_DETECTED':
    case 'PROJECT_MEMORY_EXTRACTION_FAILED':
    case 'PROJECT_MEMORY_STALE':
      return HttpStatus.BAD_REQUEST;
    case 'UNKNOWN':
    default:
      return HttpStatus.BAD_GATEWAY;
  }
}
