/**
 * Shared domain types for Project X.
 * Keep this package free of runtime dependencies.
 */

export type HealthStatus = 'ok' | 'degraded' | 'error';

export interface HealthCheckResponse {
  status: HealthStatus;
  timestamp: string;
  service: string;
  version: string;
}

export interface ApiErrorResponse {
  statusCode: number;
  message: string | string[];
  error: string;
  path?: string;
  timestamp?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
