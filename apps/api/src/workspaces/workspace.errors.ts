import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { WorkspaceErrorBody, WorkspaceErrorCode } from '@project-x/types';

export function workspaceException(
  code: WorkspaceErrorCode,
  message: string,
  details?: Record<string, unknown>,
): HttpException {
  const statusCode = statusForCode(code);
  const body: WorkspaceErrorBody & { statusCode: number } = {
    code,
    message,
    statusCode,
    ...(details ? { details } : {}),
  };

  switch (code) {
    case 'WORKSPACE_NOT_FOUND':
    case 'WORKSPACE_MEMBER_NOT_FOUND':
      return new NotFoundException(body);
    case 'WORKSPACE_ACCESS_DENIED':
    case 'WORKSPACE_INACTIVE':
    case 'WORKSPACE_OWNER_REQUIRED':
    case 'WORKSPACE_LAST_OWNER':
    case 'WORKSPACE_RESOURCE_ACCESS_DENIED':
    case 'FEATURE_NOT_AVAILABLE':
      return new ForbiddenException(body);
    case 'WORKSPACE_LIMIT_REACHED':
    case 'WORKSPACE_MEMBER_LIMIT_REACHED':
    case 'WORKSPACE_INVITATION_INVALID':
    case 'WORKSPACE_INVITATION_EXPIRED':
    case 'WORKSPACE_INVITATION_ALREADY_USED':
    case 'USAGE_LIMIT_REACHED':
    case 'PLAN_LIMIT_EXCEEDED':
    case 'SUBSCRIPTION_REQUIRED':
    case 'SUBSCRIPTION_INACTIVE':
    case 'BILLING_CONFIGURATION_INVALID':
    case 'BILLING_CHECKOUT_FAILED':
    case 'BILLING_WEBHOOK_INVALID':
    case 'BILLING_WEBHOOK_DUPLICATE':
      return new BadRequestException(body);
    default:
      return new HttpException(body, statusCode);
  }
}

function statusForCode(code: WorkspaceErrorCode): number {
  switch (code) {
    case 'WORKSPACE_NOT_FOUND':
    case 'WORKSPACE_MEMBER_NOT_FOUND':
      return HttpStatus.NOT_FOUND;
    case 'WORKSPACE_ACCESS_DENIED':
    case 'WORKSPACE_INACTIVE':
    case 'WORKSPACE_OWNER_REQUIRED':
    case 'WORKSPACE_LAST_OWNER':
    case 'WORKSPACE_RESOURCE_ACCESS_DENIED':
    case 'FEATURE_NOT_AVAILABLE':
      return HttpStatus.FORBIDDEN;
    case 'WORKSPACE_LIMIT_REACHED':
    case 'WORKSPACE_MEMBER_LIMIT_REACHED':
    case 'USAGE_LIMIT_REACHED':
    case 'PLAN_LIMIT_EXCEEDED':
      return HttpStatus.PAYMENT_REQUIRED;
    case 'BILLING_PROVIDER_UNAVAILABLE':
    case 'BILLING_SUBSCRIPTION_UPDATE_FAILED':
    case 'BILLING_RECONCILIATION_REQUIRED':
      return HttpStatus.BAD_GATEWAY;
    case 'UNKNOWN':
      return HttpStatus.INTERNAL_SERVER_ERROR;
    default:
      return HttpStatus.BAD_REQUEST;
  }
}
