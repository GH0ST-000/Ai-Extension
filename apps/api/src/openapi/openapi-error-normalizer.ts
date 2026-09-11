import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { OpenApiErrorBody, OpenApiErrorCode } from '@project-x/types';

@Injectable()
export class OpenApiErrorNormalizer {
  toHttpException(code: OpenApiErrorCode, message: string, status?: number): HttpException {
    const resolved = status ?? this.defaultStatus(code);
    const body: OpenApiErrorBody & { statusCode: number } = {
      code,
      message,
      statusCode: resolved,
    };
    return new HttpException(body, resolved);
  }

  private defaultStatus(code: OpenApiErrorCode): number {
    switch (code) {
      case 'API_DOC_FETCH_BLOCKED':
      case 'API_DOC_REDIRECT_BLOCKED':
      case 'API_DOC_EXTERNAL_REF_UNSUPPORTED':
        return HttpStatus.FORBIDDEN;
      case 'API_DOC_NOT_FOUND':
      case 'API_OPERATION_NOT_FOUND':
        return HttpStatus.NOT_FOUND;
      case 'API_DOC_INVALID':
      case 'API_DOC_TOO_LARGE':
      case 'API_DOC_UNSUPPORTED_VERSION':
      case 'API_OPERATION_AMBIGUOUS':
      case 'API_SCHEMA_TOO_COMPLEX':
      case 'API_CONTEXT_STALE':
      case 'API_CONTRACT_COMPARISON_STALE':
      case 'API_DOC_REFERENCE_LIMIT_EXCEEDED':
      case 'API_EXAMPLE_GENERATION_FAILED':
        return HttpStatus.BAD_REQUEST;
      case 'RATE_LIMITED':
        return HttpStatus.TOO_MANY_REQUESTS;
      case 'API_DOC_FETCH_FAILED':
      case 'AI_ANALYSIS_FAILED':
        return HttpStatus.BAD_GATEWAY;
      case 'UNKNOWN':
      default:
        return HttpStatus.BAD_GATEWAY;
    }
  }
}
