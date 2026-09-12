import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { MultiRepoErrorBody, MultiRepoErrorCode } from '@project-x/types';

export function multiRepoException(
  code: MultiRepoErrorCode,
  message: string,
  details?: Record<string, unknown>,
): HttpException {
  const body: MultiRepoErrorBody & { statusCode: number } = {
    code,
    message,
    statusCode: statusForCode(code),
    ...(details ? { details } : {}),
  };

  const status = body.statusCode;
  switch (code) {
    case 'SYSTEM_REPOSITORY_NOT_ACCESSIBLE':
      return new ForbiddenException(body);
    case 'SYSTEM_CONTEXT_NOT_CONFIGURED':
    case 'RELATIONSHIP_NOT_FOUND':
    case 'HTTP_CONSUMER_NOT_FOUND':
    case 'EVENT_CONSUMER_NOT_FOUND':
    case 'EVENT_PRODUCER_NOT_FOUND':
      return new NotFoundException(body);
    case 'RELATIONSHIP_CONFLICT':
      return new ConflictException(body);
    case 'SYSTEM_CONTEXT_STALE':
    case 'RELATIONSHIP_STALE':
    case 'MULTI_REPO_ANALYSIS_STALE':
      return new ServiceUnavailableException(body);
    case 'SYSTEM_REPOSITORY_LIMIT_REACHED':
    case 'SYSTEM_CONTEXT_PARTIAL':
    case 'RELATED_REPOSITORY_AMBIGUOUS':
    case 'MULTI_REPO_CONTEXT_TOO_LARGE':
    case 'MULTI_REPO_SEARCH_LIMIT_REACHED':
    case 'CONTRACT_COMPARISON_FAILED':
    case 'CHANGE_IMPACT_ANALYSIS_FAILED':
    case 'SYSTEM_FLOW_INCOMPLETE':
      return new BadRequestException(body);
    case 'UNKNOWN':
    default:
      return new HttpException(body, status);
  }
}

function statusForCode(code: MultiRepoErrorCode): number {
  switch (code) {
    case 'SYSTEM_REPOSITORY_NOT_ACCESSIBLE':
      return HttpStatus.FORBIDDEN;
    case 'SYSTEM_CONTEXT_NOT_CONFIGURED':
    case 'RELATIONSHIP_NOT_FOUND':
    case 'HTTP_CONSUMER_NOT_FOUND':
    case 'EVENT_CONSUMER_NOT_FOUND':
    case 'EVENT_PRODUCER_NOT_FOUND':
      return HttpStatus.NOT_FOUND;
    case 'RELATIONSHIP_CONFLICT':
      return HttpStatus.CONFLICT;
    case 'SYSTEM_CONTEXT_STALE':
    case 'RELATIONSHIP_STALE':
    case 'MULTI_REPO_ANALYSIS_STALE':
      return HttpStatus.SERVICE_UNAVAILABLE;
    case 'SYSTEM_REPOSITORY_LIMIT_REACHED':
    case 'SYSTEM_CONTEXT_PARTIAL':
    case 'RELATED_REPOSITORY_AMBIGUOUS':
    case 'MULTI_REPO_CONTEXT_TOO_LARGE':
    case 'MULTI_REPO_SEARCH_LIMIT_REACHED':
    case 'CONTRACT_COMPARISON_FAILED':
    case 'CHANGE_IMPACT_ANALYSIS_FAILED':
    case 'SYSTEM_FLOW_INCOMPLETE':
      return HttpStatus.BAD_REQUEST;
    case 'UNKNOWN':
    default:
      return HttpStatus.BAD_GATEWAY;
  }
}
