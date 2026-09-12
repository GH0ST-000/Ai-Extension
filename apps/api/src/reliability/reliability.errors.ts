import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ReliabilityErrorBody, ReliabilityErrorCode } from '@project-x/types';

export function reliabilityException(
  code: ReliabilityErrorCode,
  message: string,
  details?: Record<string, unknown>,
): HttpException {
  const body: ReliabilityErrorBody & { statusCode: number } = {
    code,
    message,
    statusCode: statusForCode(code),
    ...(details ? { details } : {}),
  };

  switch (code) {
    case 'EXECUTION_NOT_FOUND':
    case 'CHECKPOINT_NOT_FOUND':
      return new NotFoundException(body);
    case 'RESUME_NOT_AVAILABLE':
    case 'REPLAY_NOT_AVAILABLE':
    case 'RETRY_NOT_ALLOWED':
    case 'AUDIT_LIMIT_REACHED':
    case 'INVALID_EXECUTION_STATE':
      return new BadRequestException(body);
    case 'UNKNOWN':
    default:
      return new HttpException(body, body.statusCode);
  }
}

function statusForCode(code: ReliabilityErrorCode): number {
  switch (code) {
    case 'EXECUTION_NOT_FOUND':
    case 'CHECKPOINT_NOT_FOUND':
      return HttpStatus.NOT_FOUND;
    case 'RESUME_NOT_AVAILABLE':
    case 'REPLAY_NOT_AVAILABLE':
    case 'RETRY_NOT_ALLOWED':
    case 'AUDIT_LIMIT_REACHED':
    case 'INVALID_EXECUTION_STATE':
      return HttpStatus.BAD_REQUEST;
    case 'UNKNOWN':
    default:
      return HttpStatus.BAD_GATEWAY;
  }
}
