/**
 * Shared domain types for Project X.
 * Keep this package free of framework dependencies.
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

/**
 * Shared AI action contract used by the extension and NestJS API.
 */
export enum AIAction {
  EXPLAIN = 'EXPLAIN',
  IMPROVE_WRITING = 'IMPROVE_WRITING',
  SUMMARIZE = 'SUMMARIZE',
  TRANSLATE = 'TRANSLATE',
  EXPLAIN_CODE = 'EXPLAIN_CODE',
  REVIEW_CODE = 'REVIEW_CODE',
  SUGGEST_FIX = 'SUGGEST_FIX',
  REVIEW_ENTIRE_PR = 'REVIEW_ENTIRE_PR',
  UNDERSTAND_ERROR = 'UNDERSTAND_ERROR',
  FIND_ROOT_CAUSE = 'FIND_ROOT_CAUSE',
  CUSTOM = 'CUSTOM',
}

export const AI_ACTION_VALUES = Object.values(AIAction) as AIAction[];

/**
 * Lightweight content classification for smart action ranking (extension-local heuristics).
 * Not sent to the API unless a future feature needs it.
 */
export type ContentType = 'code' | 'error' | 'prose' | 'short-text' | 'structured-data' | 'unknown';

export const CONTENT_TYPES = [
  'code',
  'error',
  'prose',
  'short-text',
  'structured-data',
  'unknown',
] as const;

/**
 * Page context collected in the extension and sent with AI requests.
 * Website-specific DOM extraction stays in the extension; the API only
 * receives this normalized shape.
 */
export type PageContextType = 'generic' | 'github';

export const PAGE_CONTEXT_TYPES = ['generic', 'github'] as const;

export interface PageContextPageMeta {
  description?: string;
}

export interface PageContextCode {
  language?: string;
  fileName?: string;
  surroundingCode?: string;
}

export interface PageContextChangedFile {
  /** Repo-relative path of a changed file. */
  path: string;
  /** Bounded excerpt of visible diff lines for this file. */
  patchExcerpt?: string;
}

export interface PageContextGitHub {
  owner?: string;
  repository?: string;
  branch?: string;
  filePath?: string;
  pullRequestTitle?: string;
  pullRequestNumber?: number;
  /** Truncated PR description / body for review context. */
  pullRequestBody?: string;
  baseBranch?: string;
  headBranch?: string;
  /**
   * Bounded multi-file slice from the PR Files tab (Day 9).
   * Only includes files currently present in the DOM.
   */
  changedFiles?: PageContextChangedFile[];
  /** True when more files/lines existed than the budget allowed. */
  changedFilesTruncated?: boolean;
  /** True when the URL looks like the PR Files tab. */
  filesTab?: boolean;
}

export interface PageContext {
  type: PageContextType;
  url: string;
  title: string;
  surroundingText?: string;
  page?: PageContextPageMeta;
  code?: PageContextCode;
  github?: PageContextGitHub;
}

export type ResponseStyle = 'CONCISE' | 'BALANCED' | 'DETAILED';

export const RESPONSE_STYLES = ['CONCISE', 'BALANCED', 'DETAILED'] as const;

export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
}

export interface AuthTokenResponse {
  accessToken: string;
  user: AuthUser;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface UserSettings {
  maxOutputTokens: number;
  responseStyle: ResponseStyle;
  includePageContext: boolean;
}

export interface UpdateUserSettingsRequest {
  maxOutputTokens?: number;
  responseStyle?: ResponseStyle;
  includePageContext?: boolean;
}

/** Per-user GitHub connection status — never includes the raw PAT. */
export interface GitHubConnectionStatus {
  connected: boolean;
  githubLogin?: string | null;
  githubUserId?: string | null;
  updatedAt?: string | null;
}

export interface UpsertGitHubConnectionRequest {
  /** Personal Access Token from GitHub settings (fine-grained or classic). */
  token: string;
}

/** Day 12 — post a PR issue comment via server-side GitHub PAT. */
export interface PostPullRequestCommentRequest {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  body: string;
  /** Client-generated key; identical retries return the first successful result. */
  idempotencyKey: string;
}

export interface PostPullRequestCommentResponse {
  success: true;
  commentId: number;
  commentUrl: string;
  /** True when this response was served from an earlier identical request. */
  deduplicated: boolean;
}

/** Day 11 — local error classification (extension → API for error actions). */
export type ErrorCategory =
  | 'runtime'
  | 'type'
  | 'network'
  | 'http'
  | 'database'
  | 'dependency'
  | 'build'
  | 'framework'
  | 'unknown';

export interface ErrorClassification {
  isError: boolean;
  confidence: number;
  category?: ErrorCategory;
  technology?: string;
  errorCode?: string;
  signals: string[];
}

export interface StackFrame {
  functionName?: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface ErrorIntelligenceContext {
  classification: ErrorClassification;
  /** Already redacted / size-bounded error text. */
  errorText: string;
  stackTrace?: {
    raw?: string;
    frames?: StackFrame[];
  };
  page?: {
    url?: string;
    title?: string;
  };
  code?: {
    language?: string;
    fileName?: string;
    surroundingCode?: string;
  };
  github?: {
    owner?: string;
    repository?: string;
    filePath?: string;
    pullRequestNumber?: number;
    pullRequestTitle?: string;
  };
}

export interface ExecuteAiActionRequest {
  action: AIAction;
  text: string;
  customPrompt?: string | null;
  targetLanguage?: string | null;
  context?: PageContext | null;
  /** Present for Day 11 error-intelligence actions when classification is strong. */
  errorIntelligence?: ErrorIntelligenceContext | null;
}

export interface ExecuteAiActionResponse {
  success: true;
  data: {
    action: AIAction;
    result: string;
  };
}

/** Day 10 — structured PR review artifact (client-built from Day 9 markdown). */
export type PRReviewRiskLevel = 'high' | 'medium' | 'low';

export type PRReviewFindingSeverity = 'high' | 'medium' | 'low';

export interface PRReviewFinding {
  id: string;
  index: number;
  severity: PRReviewFindingSeverity;
  filePath?: string;
  title: string;
  why: string;
  /** Original markdown block for Suggest Fix follow-ups. */
  raw: string;
}

export interface PRReviewReportStats {
  analyzedFiles: number;
  skippedFiles: number;
  findings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  suggestions: number;
}

export interface PRReviewReport {
  repository: {
    owner: string;
    name: string;
  };
  pullRequest: {
    number: number;
    title?: string;
  };
  riskLevel: PRReviewRiskLevel;
  overview: string;
  stats: PRReviewReportStats;
  findings: PRReviewFinding[];
  reviewScope?: {
    truncated: boolean;
    partialFailureCount: number;
  };
}
