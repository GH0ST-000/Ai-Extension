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
  /** Day 15 — CI failure analysis (typically invoked server-side with trusted evidence). */
  ANALYZE_CI_FAILURE = 'ANALYZE_CI_FAILURE',
  /** Day 17 — Jira issue intelligence. */
  SUMMARIZE_JIRA_ISSUE = 'SUMMARIZE_JIRA_ISSUE',
  EXTRACT_ACCEPTANCE_CRITERIA = 'EXTRACT_ACCEPTANCE_CRITERIA',
  CREATE_TECHNICAL_PLAN = 'CREATE_TECHNICAL_PLAN',
  ANALYZE_JIRA_RISKS = 'ANALYZE_JIRA_RISKS',
  COMPARE_JIRA_WITH_PR = 'COMPARE_JIRA_WITH_PR',
  /** Day 18 — OpenAPI / Swagger contract intelligence. */
  EXPLAIN_API_ENDPOINT = 'EXPLAIN_API_ENDPOINT',
  EXPLAIN_API_REQUEST = 'EXPLAIN_API_REQUEST',
  EXPLAIN_API_RESPONSE = 'EXPLAIN_API_RESPONSE',
  GENERATE_API_EXAMPLE = 'GENERATE_API_EXAMPLE',
  ANALYZE_API_CONTRACT = 'ANALYZE_API_CONTRACT',
  COMPARE_API_WITH_JIRA = 'COMPARE_API_WITH_JIRA',
  ANALYZE_API_CHANGES = 'ANALYZE_API_CHANGES',
  /** Day 19 — cross-context engineering alignment (Jira + GitHub + OpenAPI). */
  ANALYZE_ENGINEERING_ALIGNMENT = 'ANALYZE_ENGINEERING_ALIGNMENT',
  /** Day 20 — safe multi-step developer workflow planning. */
  PLAN_DEVELOPER_WORKFLOW = 'PLAN_DEVELOPER_WORKFLOW',
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
export type PageContextType = 'generic' | 'github' | 'jira' | 'openapi';

export const PAGE_CONTEXT_TYPES = ['generic', 'github', 'jira', 'openapi'] as const;

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

export type JiraPageType = 'issue' | 'board' | 'backlog' | 'search' | 'project' | 'unknown';

export interface PageContextJira {
  siteHost?: string;
  pageType?: JiraPageType;
  issueKey?: string;
  projectKey?: string;
  summary?: string;
  issueType?: string;
  status?: string;
  priority?: string;
}

export type ApiDocPageType = 'swagger-ui' | 'redoc' | 'openapi-document' | 'unknown';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'TRACE';

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
] as const;

export interface PageContextOpenApi {
  pageType?: ApiDocPageType;
  origin?: string;
  /** Sanitized OpenAPI document URL (no credentials). */
  documentUrl?: string;
  selectedOperation?: {
    method: HttpMethod;
    path: string;
    operationId?: string;
    summary?: string;
  };
}

export interface PageContext {
  type: PageContextType;
  url: string;
  title: string;
  surroundingText?: string;
  page?: PageContextPageMeta;
  code?: PageContextCode;
  github?: PageContextGitHub;
  jira?: PageContextJira;
  openapi?: PageContextOpenApi;
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

/** Day 13 — GitHub pull request review event (not an AIAction). */
export type GitHubReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export const GITHUB_REVIEW_EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const;

export type GitHubReviewCommentMode = 'line' | 'pr';

export type GitHubReviewPositionStatus = 'valid' | 'unavailable' | 'stale';

export type GitHubReviewDiffSide = 'LEFT' | 'RIGHT';

/** Trusted deterministic diff coordinates only — never guess from DOM/AI. */
export interface GitHubReviewDiffPosition {
  path: string;
  line: number;
  side: GitHubReviewDiffSide;
  startLine?: number;
  startSide?: GitHubReviewDiffSide;
  commitId?: string;
}

/** Centralized GitHub review payload limits (aligned with GitHub API + project conventions). */
export const GITHUB_REVIEW_MAX_BODY_CHARACTERS = 65_536;
export const GITHUB_REVIEW_MAX_COMMENT_CHARACTERS = 65_536;
export const GITHUB_REVIEW_MAX_COMMENTS = 50;

/** Normalized GitHub write/read error codes (Day 12–15). */
export type GitHubWriteErrorCode =
  | 'NOT_CONNECTED'
  | 'INSUFFICIENT_PERMISSION'
  | 'REPOSITORY_NOT_ACCESSIBLE'
  | 'PULL_REQUEST_NOT_FOUND'
  | 'REVIEW_ACTION_NOT_ALLOWED'
  | 'REVIEW_VALIDATION_FAILED'
  | 'STALE_DIFF_POSITION'
  | 'PR_HEAD_CHANGED'
  | 'FILE_CHANGED'
  | 'PATCH_INVALID'
  | 'PATCH_CONFLICT'
  | 'PATCH_UNSUPPORTED'
  | 'BRANCH_NOT_WRITABLE'
  | 'BRANCH_PROTECTED'
  | 'COMMIT_VALIDATION_FAILED'
  | 'CHECKS_NOT_ACCESSIBLE'
  | 'CHECK_NOT_FOUND'
  | 'CHECK_DETAILS_UNAVAILABLE'
  | 'CI_LOGS_UNAVAILABLE'
  | 'CI_EVIDENCE_TOO_LARGE'
  | 'STALE_CI_CONTEXT'
  | 'AI_ANALYSIS_FAILED'
  | 'FIX_SESSION_STALE'
  | 'FIX_TARGET_NOT_FOUND'
  | 'FIX_TARGET_AMBIGUOUS'
  | 'FIX_TARGET_INVALID'
  | 'FIX_CONTEXT_INSUFFICIENT'
  | 'NEW_CI_NOT_AVAILABLE'
  | 'VERIFICATION_CHECK_NOT_FOUND'
  | 'VERIFICATION_CONTEXT_STALE'
  | 'RATE_LIMITED'
  | 'GITHUB_UNAVAILABLE'
  | 'WRITE_OUTCOME_UNKNOWN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNKNOWN';

/** Day 14 — patch apply limits. */
export const GITHUB_PATCH_MAX_FILE_BYTES = 512_000;
export const GITHUB_PATCH_MAX_COMMIT_MESSAGE_CHARACTERS = 1_024;
export const GITHUB_PATCH_MAX_PATH_CHARACTERS = 512;
export const GITHUB_PATCH_PREPARE_TTL_SECONDS = 30 * 60;

export type GitHubPatchFileOperation = 'modify' | 'create' | 'delete';

/**
 * Day 18 — trusted read of one repo path at two SHAs (Contents API via stored PAT).
 * Used for OpenAPI base/head comparison on GitHub PRs. Not a general file browser.
 */
export interface GitHubFileVersionsRequest {
  path: string;
  baseSha: string;
  headSha: string;
}

export interface GitHubFileVersionsResponse {
  owner: string;
  repository: string;
  path: string;
  baseSha: string;
  headSha: string;
  /** UTF-8 text when the path exists as a file at baseSha; null when missing. */
  baseContent: string | null;
  /** UTF-8 text when the path exists as a file at headSha; null when missing. */
  headContent: string | null;
  basePresent: boolean;
  headPresent: boolean;
}

/** Normalized single-file change for prepare/apply (Day 14 primary: modify). */
export interface GitHubPatchFileChange {
  path: string;
  operation: GitHubPatchFileOperation;
  expectedBlobSha?: string;
  originalContent?: string;
  newContent?: string;
}

export interface PreparePullRequestPatchRequest {
  /** Trusted repo-relative path — never from AI prose alone; must match finding/context. */
  path: string;
  /** Full new file content after the fix. */
  newContent: string;
  /** Optional suggested commit message (user-editable later). */
  commitMessage?: string;
  findingId?: string;
}

export interface PreparePullRequestPatchResponse {
  preparedPatchId: string;
  owner: string;
  repository: string;
  /** Head repository that will receive the commit (may differ on forks). */
  headOwner: string;
  headRepository: string;
  pullRequestNumber: number;
  headRef: string;
  expectedHeadSha: string;
  baseOwner: string;
  baseRepository: string;
  baseRef: string;
  files: Array<{
    path: string;
    operation: GitHubPatchFileOperation;
    expectedBlobSha?: string;
    originalContent: string;
    newContent: string;
    additions: number;
    deletions: number;
  }>;
  commitMessage: string;
  fingerprint: string;
  expiresAt: string;
}

export interface ApplyPullRequestPatchRequest {
  preparedPatchId: string;
  commitMessage: string;
  clientRequestId: string;
}

export interface ApplyPullRequestPatchResponse {
  success: true;
  commitSha: string;
  commitUrl: string;
  branch: string;
  appliedAt: string;
  changedFiles: number;
  deduplicated: boolean;
}

/** Session-only draft comment (extension). Credentials never stored here. */
export interface GitHubReviewDraftComment {
  id: string;
  findingId?: string;
  originalBody: string;
  body: string;
  filePath?: string;
  enabled: boolean;
  mode: GitHubReviewCommentMode;
  position?: GitHubReviewDiffPosition;
  positionStatus: GitHubReviewPositionStatus;
  severity?: 'high' | 'medium' | 'low';
  findingTitle?: string;
  /** Soft-removed from draft; finding itself is unchanged. */
  removed?: boolean;
}

export interface GitHubReviewDraftDestination {
  owner: string;
  repository: string;
  pullRequestNumber: number;
}

/** Session-only review draft bound to a trusted PR destination. */
export interface GitHubReviewDraft {
  id: string;
  destination: GitHubReviewDraftDestination;
  event: GitHubReviewEvent;
  body: string;
  comments: GitHubReviewDraftComment[];
  createdAt: string;
  sourceReviewSessionId?: string;
  expectedHeadSha?: string;
  /** True when the live page PR no longer matches destination. */
  staleNavigation?: boolean;
}

/** Immutable confirmation payload — submit only from this, never from live form state. */
export interface GitHubReviewSubmissionSnapshot {
  clientRequestId: string;
  owner: string;
  repository: string;
  pullRequestNumber: number;
  event: GitHubReviewEvent;
  body: string;
  comments: Array<{
    body: string;
    path?: string;
    line?: number;
    side?: GitHubReviewDiffSide;
    startLine?: number;
    startSide?: GitHubReviewDiffSide;
  }>;
  expectedHeadSha?: string;
  fingerprint: string;
  createdAt: string;
}

export interface SubmitPullRequestReviewRequest {
  event: GitHubReviewEvent;
  body?: string;
  comments: Array<{
    body: string;
    path?: string;
    line?: number;
    side?: GitHubReviewDiffSide;
    startLine?: number;
    startSide?: GitHubReviewDiffSide;
  }>;
  clientRequestId: string;
  expectedHeadSha?: string;
}

export interface SubmitPullRequestReviewResponse {
  success: true;
  reviewId: number;
  state: string;
  reviewUrl: string;
  submittedAt: string;
  commentCount: number;
  deduplicated: boolean;
}

export interface GitHubWriteErrorBody {
  code: GitHubWriteErrorCode;
  message: string;
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
  /** Day 24 — optional reliability execution linkage for AI audit snapshots. */
  executionId?: string | null;
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

/** Day 15 — normalized CI / check status (independent of raw GitHub strings). */
export type CIOverallStatus =
  'SUCCESS' | 'FAILURE' | 'PENDING' | 'CANCELLED' | 'NEUTRAL' | 'SKIPPED' | 'UNKNOWN';

export type CICheckRunStatus = 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'WAITING' | 'UNKNOWN';

export type CICheckConclusion =
  | 'SUCCESS'
  | 'FAILURE'
  | 'CANCELLED'
  | 'SKIPPED'
  | 'NEUTRAL'
  | 'TIMED_OUT'
  | 'ACTION_REQUIRED'
  | 'STALE'
  | 'UNKNOWN'
  | null;

export type CIEvidenceCapability =
  'STATUS_ONLY' | 'ANNOTATIONS' | 'ACTIONS_LOGS' | 'SUMMARY' | 'EXTERNAL_LINK';

/** Centralized CI evidence budgets. */
export const CI_MAX_LOG_BYTES = 256_000;
export const CI_MAX_LOG_CHARS_FOR_AI = 12_000;
export const CI_MAX_LOG_CHARS_FOR_UI = 8_000;
export const CI_MAX_ANNOTATIONS = 40;
export const CI_MAX_ANNOTATION_MESSAGE_CHARS = 2_000;
export const CI_MAX_EXCERPT_LINES = 80;
export const CI_MAX_LINE_CHARS = 500;
export const CI_MAX_FAILED_CHECKS_ANALYZED = 1;
export const CI_MAX_CHANGED_FILES_IN_CONTEXT = 40;

export interface CICheckAnnotation {
  path?: string;
  startLine?: number;
  endLine?: number;
  annotationLevel?: 'failure' | 'warning' | 'notice' | 'unknown';
  title?: string;
  message: string;
  rawDetails?: string;
}

export interface CINormalizedCheck {
  /** Stable provider id: `check_run:{id}` or `status:{context}`. */
  id: string;
  name: string;
  source?: string;
  status: CICheckRunStatus;
  conclusion: CICheckConclusion;
  startedAt?: string;
  completedAt?: string;
  /** HTTPS details URL when safely available (never signed log download URLs). */
  detailsUrl?: string;
  workflowName?: string;
  jobName?: string;
  /** Whether deeper failure evidence may be fetchable via GitHub APIs. */
  canInspectDetails: boolean;
  evidenceCapabilities: CIEvidenceCapability[];
}

export interface CICheckCounts {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  cancelled: number;
  neutral: number;
  skipped: number;
}

export interface PullRequestCISummary {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  overallStatus: CIOverallStatus;
  counts: CICheckCounts;
  checks: CINormalizedCheck[];
  fetchedAt: string;
  /** True when some check sources failed to load but others succeeded. */
  partialData?: boolean;
}

export type CILogEvidenceSource =
  'annotation' | 'check_summary' | 'actions_log' | 'changed_file' | 'other';

export interface CIFailureEvidenceItem {
  source: CILogEvidenceSource;
  label: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  excerpt: string;
  truncated?: boolean;
}

export interface CICheckFailureEvidence {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  check: CINormalizedCheck;
  summaryText?: string;
  annotations: CICheckAnnotation[];
  logExcerpt?: string;
  evidence: CIFailureEvidenceItem[];
  truncated: boolean;
  redacted: boolean;
  /** True when Actions logs were unavailable but other evidence exists. */
  logsUnavailable?: boolean;
  fetchedAt: string;
}

export type CIAnalysisConfidence = 'high' | 'medium' | 'low';
export type CIRelatedToPullRequest = 'likely' | 'unlikely' | 'uncertain';

export interface CIAffectedFile {
  path: string;
  /** True when path was validated against trusted PR/changed-file context. */
  verified: boolean;
  reason?: string;
  startLine?: number;
}

export interface CIFailureAnalysis {
  summary: string;
  likelyRootCause: string;
  confidence: CIAnalysisConfidence;
  relatedToPullRequest: CIRelatedToPullRequest;
  evidence: CIFailureEvidenceItem[];
  affectedFiles: CIAffectedFile[];
  suggestedNextSteps: string[];
  canSuggestFix: boolean;
  evidenceTruncated: boolean;
  owner: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  checkId: string;
  analyzedAt: string;
}

export interface AnalyzeCIFailureRequest {
  /** Optional client-known head; mismatch with trusted head → STALE_CI_CONTEXT. */
  expectedHeadSha?: string;
  /** Bounded changed-file paths from page context (correlation only). */
  changedFiles?: Array<{ path: string }>;
  pullRequestTitle?: string;
}

export interface AnalyzeCIFailureResponse {
  analysis: CIFailureAnalysis;
  evidence: CICheckFailureEvidence;
}

/** Day 16 — CI Fix Session status (single state machine; not booleans). */
export type CIFixSessionStatus =
  | 'IDLE'
  | 'ANALYZING'
  | 'ANALYZED'
  | 'TARGET_REQUIRED'
  | 'READY_TO_SUGGEST'
  | 'SUGGESTING'
  | 'SUGGESTED'
  | 'PATCH_READY'
  | 'APPLYING'
  | 'COMMIT_CREATED'
  | 'WAITING_FOR_NEW_CI'
  | 'VERIFYING'
  | 'PASSED'
  | 'STILL_FAILING'
  | 'DIFFERENT_FAILURE'
  | 'CHECK_NOT_FOUND'
  | 'STALE'
  | 'ERROR';

export type CIFixTargetSource = 'annotation' | 'log' | 'changed-file-correlation' | 'ai-suggestion';

export type CIFixTargetTrust = 'trusted' | 'correlated' | 'suggested';

export interface CIFixTarget {
  filePath: string;
  startLine?: number;
  endLine?: number;
  source: CIFixTargetSource;
  trust: CIFixTargetTrust;
  /** Path passed repository-relative validation. */
  verified: boolean;
  /** True when path appears in PR changed-files context. */
  inPullRequestDiff?: boolean;
  reason?: string;
}

export type CIFixVerificationStatus =
  | 'PENDING'
  | 'PASSED'
  | 'STILL_FAILING'
  | 'DIFFERENT_FAILURE'
  | 'CHECK_NOT_FOUND'
  | 'CANCELLED'
  | 'SKIPPED'
  | 'NEUTRAL'
  | 'UNKNOWN';

export interface CIFixVerification {
  originalCheckId: string;
  originalCheckName: string;
  originalHeadSha: string;
  newHeadSha: string;
  matchedCheckId?: string;
  matchedCheckName?: string;
  status: CIFixVerificationStatus;
  comparedAt: string;
  previousFailureSignature?: string;
  currentFailureSignature?: string;
  /** True when overall PR CI still has other failures after targeted pass. */
  otherChecksFailing?: boolean;
  overallStatus?: CIOverallStatus;
}

export interface CIFixSessionSourceCheck {
  id: string;
  name: string;
  status: CICheckRunStatus;
  conclusion?: CICheckConclusion;
}

export interface CIFixAppliedCommit {
  sha: string;
  url?: string;
  branch?: string;
}

export interface CIFixSuggestionSnapshot {
  /** Bounded text used for Suggest Fix (not a verified patch). */
  summary: string;
  createdAt: string;
}

/** Session-scoped CI remediation loop (Day 16) — not persisted to PostgreSQL. */
export interface CIFixSession {
  id: string;
  repository: {
    owner: string;
    name: string;
  };
  pullRequestNumber: number;
  sourceHeadSha: string;
  sourceCheck: CIFixSessionSourceCheck;
  analysis?: CIFailureAnalysis;
  candidateTargets: CIFixTarget[];
  selectedTarget?: CIFixTarget;
  suggestion?: CIFixSuggestionSnapshot;
  appliedCommit?: CIFixAppliedCommit;
  currentHeadSha?: string;
  verification?: CIFixVerification;
  previousFailureSignature?: string;
  originalFailureCleared?: boolean;
  status: CIFixSessionStatus;
  errorMessage?: string;
  errorCode?: GitHubWriteErrorCode;
  createdAt: string;
  updatedAt: string;
}

/** Day 17 — Jira Cloud connection status (never includes API token). */
export interface JiraConnectionStatus {
  connected: boolean;
  siteHost?: string | null;
  siteDisplayName?: string | null;
  accountId?: string | null;
  displayName?: string | null;
  updatedAt?: string | null;
}

export interface UpsertJiraConnectionRequest {
  /** Atlassian account email used with the API token. */
  email: string;
  /** Atlassian API token (not password). */
  apiToken: string;
  /**
   * Jira Cloud site host only, e.g. `company.atlassian.net`.
   * Must be HTTPS *.atlassian.net — never an arbitrary URL.
   */
  siteHost: string;
}

export type JiraErrorCode =
  | 'JIRA_NOT_CONNECTED'
  | 'JIRA_SITE_NOT_CONNECTED'
  | 'JIRA_SITE_NOT_ACCESSIBLE'
  | 'JIRA_ISSUE_NOT_FOUND'
  | 'JIRA_ISSUE_NOT_ACCESSIBLE'
  | 'JIRA_PERMISSION_REQUIRED'
  | 'JIRA_RATE_LIMITED'
  | 'JIRA_UNAVAILABLE'
  | 'JIRA_CONTEXT_STALE'
  | 'JIRA_CONTENT_UNSUPPORTED'
  | 'JIRA_PR_LINK_NOT_FOUND'
  | 'JIRA_PR_LINK_AMBIGUOUS'
  | 'JIRA_PR_COMPARISON_STALE'
  | 'UNKNOWN';

export interface JiraErrorBody {
  code: JiraErrorCode;
  message: string;
}

/** Centralized Jira context budgets. */
export const JIRA_MAX_DESCRIPTION_CHARS = 12_000;
export const JIRA_MAX_COMMENTS = 8;
export const JIRA_MAX_COMMENT_CHARS = 2_000;
export const JIRA_MAX_TOTAL_CONTEXT_CHARS = 20_000;

export interface JiraRichTextNormalized {
  plainText: string;
  truncated: boolean;
}

export interface JiraIssueLink {
  type?: string;
  direction?: 'inward' | 'outward';
  issueKey?: string;
  issueSummary?: string;
}

export interface JiraCommentSummary {
  id: string;
  authorDisplayName?: string;
  createdAt?: string;
  body: JiraRichTextNormalized;
}

export interface JiraIssue {
  id: string;
  key: string;
  project: {
    id?: string;
    key: string;
    name?: string;
  };
  issueType?: string;
  summary: string;
  description?: JiraRichTextNormalized;
  status?: {
    id?: string;
    name: string;
    category?: string;
  };
  priority?: string;
  assignee?: {
    accountId?: string;
    displayName?: string;
  };
  reporter?: {
    accountId?: string;
    displayName?: string;
  };
  labels?: string[];
  components?: string[];
  fixVersions?: string[];
  createdAt?: string;
  updatedAt?: string;
  links?: JiraIssueLink[];
  comments?: JiraCommentSummary[];
  attachmentCount?: number;
  attachmentNames?: string[];
  url?: string;
  siteHost: string;
  /** True when description/comments were truncated for budgets. */
  truncated?: boolean;
  fetchedAt: string;
}

export type AcceptanceCriterionSource = 'description' | 'comment' | 'inferred';
export type AcceptanceCriterionTestability = 'clear' | 'partial' | 'unclear';

export interface AcceptanceCriterion {
  id: string;
  text: string;
  source?: AcceptanceCriterionSource;
  testability?: AcceptanceCriterionTestability;
}

export interface JiraAcceptanceCriteriaAnalysis {
  explicit: AcceptanceCriterion[];
  inferred: AcceptanceCriterion[];
  openQuestions: string[];
  completeness: 'high' | 'medium' | 'low';
}

export type JiraGitHubLinkSource = 'pr-title' | 'pr-body' | 'branch-name' | 'explicit';

export interface JiraGitHubLinkCandidate {
  issueKey: string;
  repository: {
    owner: string;
    name: string;
  };
  pullRequestNumber: number;
  pullRequestTitle?: string;
  source: JiraGitHubLinkSource;
  confidence: 'high' | 'medium';
}

export type RequirementCoverageStatus = 'covered' | 'partial' | 'not-evident' | 'uncertain';

export interface RequirementCoverage {
  requirement: string;
  status: RequirementCoverageStatus;
  evidence?: Array<{
    kind: 'file' | 'diff' | 'finding' | 'pr-description' | 'other';
    path?: string;
    note?: string;
  }>;
  notes?: string;
}

export interface ScopeObservation {
  observation: string;
  evidence?: string;
}

export interface AcceptanceCriteriaCoverage {
  criterion: string;
  source: AcceptanceCriterionSource | 'unknown';
  status: RequirementCoverageStatus;
  notes?: string;
}

export interface JiraPRRisk {
  severity: 'high' | 'medium' | 'low';
  text: string;
  kind: 'known' | 'potential' | 'question';
}

export type JiraPRAlignment = 'strong' | 'partial' | 'weak' | 'uncertain';

export interface JiraPRComparison {
  issueKey: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  alignment: JiraPRAlignment;
  overview: string;
  coveredRequirements: RequirementCoverage[];
  missingOrUnclearRequirements: RequirementCoverage[];
  implementationBeyondScope: ScopeObservation[];
  acceptanceCriteriaCoverage: AcceptanceCriteriaCoverage[];
  risks: JiraPRRisk[];
  openQuestions: string[];
  reviewScopeTruncated?: boolean;
  analyzedAt: string;
}

/** Day 18 — OpenAPI / Swagger intelligence budgets. */
export const OPENAPI_MAX_DOCUMENT_BYTES = 1_500_000;
export const OPENAPI_MAX_OPERATIONS = 200;
export const OPENAPI_MAX_SCHEMAS = 300;
export const OPENAPI_MAX_SCHEMA_DEPTH = 12;
export const OPENAPI_MAX_PROPERTIES = 80;
export const OPENAPI_MAX_DESCRIPTION_CHARS = 2_000;
export const OPENAPI_MAX_AI_CONTEXT_CHARS = 18_000;
export const OPENAPI_MAX_REDIRECTS = 3;
export const OPENAPI_FETCH_TIMEOUT_MS = 12_000;

export type OpenApiErrorCode =
  | 'API_DOC_NOT_FOUND'
  | 'API_DOC_INVALID'
  | 'API_DOC_TOO_LARGE'
  | 'API_DOC_UNSUPPORTED_VERSION'
  | 'API_DOC_FETCH_BLOCKED'
  | 'API_DOC_FETCH_FAILED'
  | 'API_DOC_REDIRECT_BLOCKED'
  | 'API_DOC_EXTERNAL_REF_UNSUPPORTED'
  | 'API_DOC_REFERENCE_LIMIT_EXCEEDED'
  | 'API_OPERATION_NOT_FOUND'
  | 'API_OPERATION_AMBIGUOUS'
  | 'API_SCHEMA_TOO_COMPLEX'
  | 'API_CONTEXT_STALE'
  | 'API_CONTRACT_COMPARISON_STALE'
  | 'API_EXAMPLE_GENERATION_FAILED'
  | 'RATE_LIMITED'
  | 'AI_ANALYSIS_FAILED'
  | 'UNKNOWN';

export interface OpenApiErrorBody {
  code: OpenApiErrorCode;
  message: string;
}

export interface ApiServer {
  url: string;
  description?: string;
}

export interface ApiTag {
  name: string;
  description?: string;
}

export interface NormalizedApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  description?: string;
  schema?: NormalizedApiSchema;
  deprecated?: boolean;
}

export interface NormalizedRequestBody {
  required: boolean;
  description?: string;
  contentType?: string;
  schema?: NormalizedApiSchema;
}

export interface NormalizedApiResponse {
  statusCode: string;
  description?: string;
  contentType?: string;
  schema?: NormalizedApiSchema;
}

export interface NormalizedSecurityRequirement {
  name: string;
  scopes?: string[];
}

export interface NormalizedApiSchema {
  name?: string;
  type?: string;
  format?: string;
  description?: string;
  required?: string[];
  nullable?: boolean;
  enum?: Array<string | number | boolean | null>;
  default?: unknown;
  example?: unknown;
  properties?: Record<string, NormalizedApiSchema>;
  items?: NormalizedApiSchema;
  oneOf?: NormalizedApiSchema[];
  anyOf?: NormalizedApiSchema[];
  allOf?: NormalizedApiSchema[];
  additionalProperties?: boolean | NormalizedApiSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  truncated?: boolean;
  unresolvedRef?: string;
}

export interface NormalizedApiOperation {
  id: string;
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters: NormalizedApiParameter[];
  requestBody?: NormalizedRequestBody;
  responses: NormalizedApiResponse[];
  security?: NormalizedSecurityRequirement[];
}

export interface NormalizedApiContract {
  version: string;
  title?: string;
  description?: string;
  servers: ApiServer[];
  tags: ApiTag[];
  operations: NormalizedApiOperation[];
  schemas: Record<string, NormalizedApiSchema>;
  source: {
    type: 'url' | 'page';
    /** Sanitized document URL (credentials stripped). */
    documentUrl?: string;
  };
  documentHash: string;
  partial?: boolean;
  warnings?: string[];
  operationCountTotal?: number;
  operationCountIncluded?: number;
  fetchedAt: string;
}

export interface ParseOpenApiUrlRequest {
  url: string;
}

export interface ParseOpenApiContentRequest {
  content: string;
  /** Optional page origin for logging only — not used as a fetch target. */
  pageOrigin?: string;
  sourceUrl?: string;
}

export interface GenerateApiExampleRequest {
  documentHash: string;
  operationId: string;
}

export interface ApiGeneratedExample {
  method: HttpMethod;
  path: string;
  curl: string;
  headers: Record<string, string>;
  body?: unknown;
  notes: string[];
}

export interface ApiContractEvidence {
  kind: 'operation' | 'parameter' | 'request-schema' | 'response' | 'schema-field' | 'security';
  operationId?: string;
  method?: HttpMethod;
  path?: string;
  name?: string;
  statusCode?: string;
  note?: string;
}

export interface ApiContractFinding {
  id: string;
  severity: 'high' | 'medium' | 'low';
  category: string;
  title: string;
  description: string;
  evidence: ApiContractEvidence[];
  recommendation?: string;
}

export interface ApiContractAnalysis {
  overview: string;
  riskLevel: 'high' | 'medium' | 'low';
  findings: ApiContractFinding[];
  openQuestions: string[];
  scope?: string;
}

export type ApiContractChangeKind =
  | 'removed-endpoint'
  | 'added-endpoint'
  | 'removed-response'
  | 'added-response'
  | 'new-required-request-field'
  | 'removed-response-field'
  | 'type-change'
  | 'enum-narrowing'
  | 'enum-widening'
  | 'security-change'
  | 'other';

export type ApiContractChangeImpact = 'breaking' | 'non-breaking' | 'uncertain';

export interface ApiContractChange {
  id: string;
  kind: ApiContractChangeKind;
  impact: ApiContractChangeImpact;
  title: string;
  description: string;
  method?: HttpMethod;
  path?: string;
}

export interface ApiContractDiff {
  baseRef: string;
  headRef: string;
  baseHash: string;
  headHash: string;
  breakingChanges: ApiContractChange[];
  nonBreakingChanges: ApiContractChange[];
  uncertainChanges: ApiContractChange[];
}

export interface ApiRequirementCoverage {
  requirement: string;
  status: 'covered' | 'partial' | 'not-evident' | 'uncertain';
  notes?: string;
  evidence?: string;
}

export interface ApiRequirementRisk {
  severity: 'high' | 'medium' | 'low';
  text: string;
  kind: 'fact' | 'potential' | 'recommendation';
}

export interface JiraApiComparison {
  issueKey: string;
  operationId?: string;
  method: HttpMethod;
  path: string;
  documentHash: string;
  alignment: 'strong' | 'partial' | 'weak' | 'uncertain';
  coveredCriteria: ApiRequirementCoverage[];
  missingOrUnclearCriteria: ApiRequirementCoverage[];
  risks: ApiRequirementRisk[];
  openQuestions: string[];
  analyzedAt: string;
}

/** Day 19 — cross-context engineering alignment budgets. */
export const ENGINEERING_MAX_JIRA_CHARS = 6_000;
export const ENGINEERING_MAX_ACCEPTANCE_CRITERIA = 20;
export const ENGINEERING_MAX_PR_FILES = 14;
export const ENGINEERING_MAX_DIFF_CHARS = 10_000;
export const ENGINEERING_MAX_FINDINGS = 20;
export const ENGINEERING_MAX_API_CONTEXT_CHARS = 8_000;
export const ENGINEERING_MAX_CI_CHARS = 1_500;
export const ENGINEERING_MAX_TOTAL_PROMPT_CHARS = 22_000;
export const ENGINEERING_MAX_EVIDENCE_EXCERPT = 280;

export type EngineeringErrorCode =
  | 'ENGINEERING_CONTEXT_INSUFFICIENT'
  | 'ENGINEERING_CONTEXT_AMBIGUOUS'
  | 'ENGINEERING_CONTEXT_STALE'
  | 'ENGINEERING_CONTEXT_SOURCE_UNAVAILABLE'
  | 'ENGINEERING_CONTEXT_BUILD_FAILED'
  | 'ENGINEERING_ALIGNMENT_FAILED'
  | 'ENGINEERING_EVIDENCE_INVALID'
  | 'ENGINEERING_CONTEXT_TOO_LARGE'
  | 'UNKNOWN';

export interface EngineeringErrorBody {
  code: EngineeringErrorCode;
  message: string;
}

export type EngineeringContextSource = 'jira' | 'github-pr' | 'github-review' | 'openapi' | 'ci';

export type EngineeringConfidence = 'high' | 'medium' | 'low';

export type EngineeringCoverageStatus =
  'covered' | 'partial' | 'not-evident' | 'conflicting' | 'uncertain';

export type EngineeringAlignment = 'strong' | 'partial' | 'weak' | 'conflicting' | 'uncertain';

export type EngineeringEvidenceSource =
  'jira' | 'github-diff' | 'github-finding' | 'openapi' | 'ci';

export interface EngineeringEvidenceReference {
  issueKey?: string;
  criterionId?: string;
  filePath?: string;
  line?: number;
  operationId?: string;
  method?: string;
  path?: string;
  responseCode?: string;
  checkId?: string;
  findingId?: string;
}

export interface EngineeringEvidence {
  source: EngineeringEvidenceSource;
  label: string;
  reference?: EngineeringEvidenceReference;
  excerpt?: string;
}

export type EngineeringFileRelevance = 'high' | 'medium' | 'low';

export interface EngineeringChangedFile {
  path: string;
  patchExcerpt?: string;
  relevance?: EngineeringFileRelevance;
}

export interface EngineeringFindingSummary {
  id: string;
  severity: PRReviewFindingSeverity;
  title: string;
  filePath?: string;
}

export interface EngineeringCICheckSummary {
  name: string;
  conclusion?: string;
  htmlUrl?: string;
}

/** Lean PR review summary for engineering context (not a full PRReviewReport). */
export interface PRReviewReportSummary {
  riskLevel: PRReviewRiskLevel;
  overview?: string;
  findingCount?: number;
  truncated?: boolean;
}

/** Lean API contract diff summary for engineering context. */
export interface ApiContractDiffSummary {
  baseRef?: string;
  headRef?: string;
  breakingCount: number;
  nonBreakingCount: number;
  uncertainCount: number;
}

export interface EngineeringContextJiraSlice {
  issueKey: string;
  siteHost: string;
  updatedAt?: string;
  summary: string;
  /** Bounded plain-text description excerpt for prompts (untrusted). */
  descriptionExcerpt?: string;
  explicitAcceptanceCriteria: AcceptanceCriterion[];
  inferredAcceptanceCriteria?: AcceptanceCriterion[];
  truncated?: boolean;
}

export interface EngineeringContextGitHubSlice {
  repository: {
    owner: string;
    name: string;
  };
  pullRequestNumber: number;
  headSha: string;
  baseSha?: string;
  title?: string;
  changedFiles: EngineeringChangedFile[];
  reviewReport?: PRReviewReportSummary;
  findings?: EngineeringFindingSummary[];
}

export interface EngineeringContextApiSlice {
  documentHash: string;
  title?: string;
  operation?: {
    method: HttpMethod;
    path: string;
    operationId?: string;
  };
  /** Bounded operation/contract text for prompts (untrusted). */
  contextExcerpt?: string;
  contractFindings?: ApiContractFinding[];
  contractDiff?: ApiContractDiffSummary;
}

export interface EngineeringContextCISlice {
  headSha: string;
  status?: string;
  failedChecks?: EngineeringCICheckSummary[];
  /** Bounded CI summary text for prompts (untrusted). */
  summaryExcerpt?: string;
}

export interface EngineeringContextScope {
  partial: boolean;
  truncationReasons: string[];
  includedSources: EngineeringContextSource[];
}

export interface EngineeringContext {
  id: string;
  createdAt: string;
  jira?: EngineeringContextJiraSlice;
  github?: EngineeringContextGitHubSlice;
  api?: EngineeringContextApiSlice;
  ci?: EngineeringContextCISlice;
  scope: EngineeringContextScope;
}

export interface AnalysisBinding {
  jira?: {
    issueKey: string;
    updatedAt?: string;
  };
  github?: {
    repository: string;
    prNumber: number;
    headSha: string;
  };
  api?: {
    documentHash: string;
    operationKey?: string;
  };
  ci?: {
    headSha: string;
    checkIds?: string[];
  };
}

export interface EngineeringRequirementCoverage {
  criterionId: string;
  criterion: string;
  /** Prefer explicit; inferred must be labeled separately. */
  criterionSource?: AcceptanceCriterionSource;
  status: EngineeringCoverageStatus;
  evidence: EngineeringEvidence[];
  notes?: string;
  confidence: EngineeringConfidence;
}

export interface EngineeringImplementationObservation {
  observation: string;
  kind?: 'beyond-scope' | 'implementation' | 'other';
  evidence?: EngineeringEvidence[];
  confidence?: EngineeringConfidence;
}

export interface EngineeringContractAlignment {
  aspect: string;
  status: EngineeringCoverageStatus;
  evidence?: EngineeringEvidence[];
  notes?: string;
  confidence?: EngineeringConfidence;
}

export interface EngineeringContextConflict {
  id: string;
  severity: 'high' | 'medium' | 'low';
  sources: EngineeringContextSource[];
  title: string;
  description: string;
  evidence: EngineeringEvidence[];
  recommendation?: string;
}

export interface EngineeringAlignmentRisk {
  severity: 'high' | 'medium' | 'low';
  title: string;
  description?: string;
  evidence?: EngineeringEvidence[];
  kind?: 'fact' | 'potential' | 'recommendation';
}

export interface EngineeringAlignmentAnalysis {
  overview: string;
  alignment: EngineeringAlignment;
  requirementCoverage: EngineeringRequirementCoverage[];
  implementationObservations: EngineeringImplementationObservation[];
  contractAlignment: EngineeringContractAlignment[];
  crossContextConflicts: EngineeringContextConflict[];
  risks: EngineeringAlignmentRisk[];
  openQuestions: string[];
  scope: {
    partial: boolean;
    limitations: string[];
  };
  analyzedAt: string;
  binding: AnalysisBinding;
}

/** Lean inputs accepted by the pure engineering context builder. */
export interface EngineeringContextBuildInput {
  jira?: {
    issueKey: string;
    siteHost: string;
    updatedAt?: string;
    summary: string;
    descriptionPlainText?: string;
    explicitAcceptanceCriteria?: AcceptanceCriterion[];
    inferredAcceptanceCriteria?: AcceptanceCriterion[];
  };
  github?: {
    repository: {
      owner: string;
      name: string;
    };
    pullRequestNumber: number;
    headSha: string;
    baseSha?: string;
    title?: string;
    changedFiles: Array<{
      path: string;
      patch?: string;
    }>;
    findings?: EngineeringFindingSummary[];
    reviewReport?: PRReviewReportSummary;
  };
  api?: {
    documentHash: string;
    title?: string;
    operation?: {
      method: HttpMethod;
      path: string;
      operationId?: string;
    };
    contextText?: string;
    contractFindings?: ApiContractFinding[];
    contractDiff?: ApiContractDiffSummary;
  };
  ci?: {
    headSha: string;
    status?: string;
    failedChecks?: EngineeringCICheckSummary[];
    summaryText?: string;
  };
  /** Optional fixed timestamp for deterministic tests. */
  createdAt?: string;
}

/** Day 20/21 — developer workflow agent budgets. */
export const WORKFLOW_MAX_STEPS = 16;
export const WORKFLOW_MAX_WRITE_CHECKPOINTS = 2;
export const WORKFLOW_MAX_AI_CALLS = 8;
export const WORKFLOW_MAX_PLAN_ATTEMPTS = 3;
export const WORKFLOW_MAX_GOAL_CHARS = 2000;
export const WORKFLOW_MAX_PROVIDER_READS = 20;
export const WORKFLOW_MAX_REPLANS = 3;
export const WORKFLOW_MAX_BRANCH_DEPTH = 4;
export const WORKFLOW_MAX_PLANNING_RETRIES = 3;

export type WorkflowErrorCode =
  | 'WORKFLOW_PLAN_INVALID'
  | 'WORKFLOW_PLAN_TOO_LARGE'
  | 'WORKFLOW_CAPABILITY_NOT_ALLOWED'
  | 'WORKFLOW_DEPENDENCY_INVALID'
  | 'WORKFLOW_CONTEXT_INSUFFICIENT'
  | 'WORKFLOW_CONTEXT_STALE'
  | 'WORKFLOW_STEP_FAILED'
  | 'WORKFLOW_STEP_NOT_RETRYABLE'
  | 'WORKFLOW_USER_INPUT_REQUIRED'
  | 'WORKFLOW_WRITE_CONFIRMATION_REQUIRED'
  | 'WORKFLOW_REPLAN_REQUIRED'
  | 'WORKFLOW_BUDGET_EXCEEDED'
  | 'WORKFLOW_CANCELLED'
  | 'WORKFLOW_ARTIFACT_NOT_FOUND'
  | 'WORKFLOW_ARTIFACT_STALE'
  | 'AGENT_GOAL_INVALID'
  | 'AGENT_GOAL_UNSUPPORTED'
  | 'AGENT_GOAL_AMBIGUOUS'
  | 'AGENT_PLAN_INVALID'
  | 'AGENT_PLAN_UNSAFE'
  | 'AGENT_PLAN_CONFLICTS_WITH_GOAL'
  | 'AGENT_PLAN_COMPLETION_INVALID'
  | 'AGENT_PLAN_REVISION_REQUIRED'
  | 'AGENT_PLAN_REVISION_INVALID'
  | 'AGENT_CONTEXT_CHANGED'
  | 'AGENT_ARTIFACT_STALE'
  | 'AGENT_PRECONDITION_FAILED'
  | 'AGENT_BUDGET_EXCEEDED'
  | 'AGENT_GOAL_NOT_SATISFIED'
  | 'AGENT_BLOCKED'
  | 'UNKNOWN';

export interface WorkflowErrorBody {
  code: WorkflowErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export const WorkflowStepType = {
  BUILD_ENGINEERING_CONTEXT: 'BUILD_ENGINEERING_CONTEXT',
  SUMMARIZE_JIRA: 'SUMMARIZE_JIRA',
  EXTRACT_ACCEPTANCE_CRITERIA: 'EXTRACT_ACCEPTANCE_CRITERIA',
  ANALYZE_ENGINEERING_ALIGNMENT: 'ANALYZE_ENGINEERING_ALIGNMENT',
  REVIEW_PULL_REQUEST: 'REVIEW_PULL_REQUEST',
  ANALYZE_API_CONTRACT: 'ANALYZE_API_CONTRACT',
  ANALYZE_CI_FAILURE: 'ANALYZE_CI_FAILURE',
  SUGGEST_FIX: 'SUGGEST_FIX',
  GENERATE_PATCH: 'GENERATE_PATCH',
  PREPARE_PATCH: 'PREPARE_PATCH',
  APPLY_PATCH: 'APPLY_PATCH',
  REFRESH_CI: 'REFRESH_CI',
  VERIFY_CI_FIX: 'VERIFY_CI_FIX',
  GENERATE_PR_COMMENT: 'GENERATE_PR_COMMENT',
  CREATE_REVIEW_DRAFT: 'CREATE_REVIEW_DRAFT',
  SUBMIT_PR_COMMENT: 'SUBMIT_PR_COMMENT',
  SUBMIT_PR_REVIEW: 'SUBMIT_PR_REVIEW',
  USER_SELECT_FINDING: 'USER_SELECT_FINDING',
  USER_SELECT_FIX_TARGET: 'USER_SELECT_FIX_TARGET',
  USER_SELECT_REVIEW_EVENT: 'USER_SELECT_REVIEW_EVENT',
  /** Day 23 — multi-repo intelligence (read-only). */
  BUILD_MULTI_REPO_CONTEXT: 'BUILD_MULTI_REPO_CONTEXT',
  ANALYZE_CHANGE_IMPACT: 'ANALYZE_CHANGE_IMPACT',
  TRACE_SYSTEM_FLOW: 'TRACE_SYSTEM_FLOW',
  COMPARE_REQUIREMENT_ACROSS_REPOS: 'COMPARE_REQUIREMENT_ACROSS_REPOS',
  FIND_API_CONSUMERS: 'FIND_API_CONSUMERS',
  FIND_EVENT_CONSUMERS: 'FIND_EVENT_CONSUMERS',
} as const;

export type WorkflowStepType = (typeof WorkflowStepType)[keyof typeof WorkflowStepType];

export const WORKFLOW_STEP_TYPE_VALUES = Object.values(WorkflowStepType) as WorkflowStepType[];

export type WorkflowSessionStatus =
  | 'DRAFTING_PLAN'
  | 'PLAN_READY'
  | 'AWAITING_PLAN_APPROVAL'
  | 'AWAITING_REVISION_APPROVAL'
  | 'AWAITING_CONTEXT_SELECTION'
  | 'RUNNING'
  | 'AWAITING_USER_INPUT'
  | 'AWAITING_CONFIRMATION'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'STALE'
  | 'CANCELLED'
  | 'NEEDS_ATTENTION';

export type WorkflowStepStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'WAITING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SKIPPED'
  | 'STALE'
  | 'CANCELLED';

export type WorkflowExecutionMode = 'AUTO_READ' | 'USER_DECISION' | 'EXPLICIT_CONFIRMATION';

export type WorkflowMutationRisk = 'NONE' | 'LOW' | 'WRITE';

export type WorkflowContextRequirement = 'jira' | 'github' | 'api' | 'ci';

/** Mirrors AnalysisBinding identity fields for workflow stale checks. */
export interface WorkflowContextBinding {
  jira?: {
    issueKey: string;
    updatedAt?: string;
  };
  github?: {
    repository: string;
    prNumber: number;
    headSha: string;
  };
  api?: {
    documentHash: string;
    operationKey?: string;
  };
  ci?: {
    headSha: string;
    checkIds?: string[];
  };
}

export type WorkflowConditionType =
  | 'HAS_HIGH_FINDINGS'
  | 'HAS_BLOCKING_FINDINGS'
  | 'CI_TARGET_FAILED'
  | 'CI_TARGET_PASSED'
  | 'CI_DIFFERENT_FAILURE'
  | 'HAS_ENGINEERING_CONTEXT'
  | 'PATCH_PREPARED'
  | 'PATCH_APPLIED'
  | 'REVIEW_DRAFT_READY'
  | 'CONTEXT_PARTIAL'
  | 'ALWAYS';

export interface WorkflowStepCondition {
  type: WorkflowConditionType;
  /** When true, step runs only if the fact is false (deterministic invert). */
  negate?: boolean;
}

export type AgentDesiredOutcome =
  | 'UNDERSTAND'
  | 'ASSESS'
  | 'REVIEW'
  | 'PREPARE_FIX'
  | 'APPLY_FIX'
  | 'VERIFY'
  | 'PREPARE_REVIEW'
  | 'CUSTOM_ALLOWED_GOAL';

export type AgentGoalConstraint =
  | { type: 'FOCUS'; value: string }
  | { type: 'FILE_SCOPE'; paths: string[] }
  | { type: 'SEVERITY_SCOPE'; severities: PRReviewFindingSeverity[] }
  | { type: 'NO_WRITE' }
  | { type: 'NO_PATCH_APPLY' }
  | { type: 'NO_REVIEW_SUBMISSION' }
  | { type: 'REQUIRE_CONTEXT'; source: EngineeringContextSource };

export type AgentPlanConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface DeveloperAgentGoal {
  id: string;
  originalText: string;
  normalizedIntent: {
    objective: string;
    scope: {
      jiraIssue?: string;
      repository?: string;
      pullRequestNumber?: number;
      apiOperation?: string;
      ciCheck?: string;
    };
    desiredOutcome: AgentDesiredOutcome;
    constraints: AgentGoalConstraint[];
  };
  unsupportedRequests: string[];
  createdAt: string;
}

export type WorkflowCompletionCriterion =
  | { type: 'ANALYSIS_PRESENTED'; artifactType: WorkflowArtifactKind }
  | { type: 'PR_REVIEW_COMPLETED' }
  | { type: 'PATCH_PREPARED' }
  | { type: 'PATCH_APPLIED' }
  | { type: 'CI_CHECK_VERIFIED'; expected: 'PASSED' }
  | { type: 'REVIEW_DRAFT_PREPARED' }
  | { type: 'REVIEW_SUBMITTED' };

export type WorkflowFactName =
  | 'HAS_BLOCKING_FINDINGS'
  | 'HAS_HIGH_FINDINGS'
  | 'CRITICAL_FINDING_COUNT'
  | 'HIGH_FINDING_COUNT'
  | 'PATCH_PREPARED'
  | 'PATCH_APPLIED'
  | 'CI_TARGET_PASSED'
  | 'CI_TARGET_FAILED'
  | 'CI_DIFFERENT_FAILURE'
  | 'REVIEW_DRAFT_READY'
  | 'CONTEXT_PARTIAL'
  | 'HAS_ENGINEERING_CONTEXT'
  /** Day 23 — multi-repo intelligence facts. */
  | 'MULTI_REPO_IMPACT_FOUND'
  | 'HIGH_IMPACT_REPOSITORY_COUNT'
  | 'CROSS_REPO_CONTRACT_RISK'
  | 'KNOWN_API_CONSUMER_FOUND'
  | 'KNOWN_EVENT_CONSUMER_FOUND'
  | 'SYSTEM_FLOW_INCOMPLETE'
  | 'SYSTEM_CONTEXT_PARTIAL';

export type WorkflowFactValue = boolean | number;

export interface WorkflowFact {
  name: WorkflowFactName;
  value: WorkflowFactValue;
  sourceStepId?: string;
}

export type WorkflowArtifactProvenanceStatus = 'CURRENT' | 'STALE' | 'INVALID';

export interface WorkflowArtifactProvenance {
  artifactId: string;
  artifactType: WorkflowArtifactKind;
  producedByStepId?: string;
  bindings: WorkflowContextBinding;
  createdAt: string;
  status: WorkflowArtifactProvenanceStatus;
}

export type WorkflowCapabilityPreconditionType =
  | 'HAS_CONTEXT'
  | 'HAS_ARTIFACT'
  | 'ARTIFACT_CURRENT'
  | 'USER_SELECTED_TARGET'
  | 'PROVIDER_CONNECTED'
  | 'WRITE_PERMISSION_AVAILABLE'
  | 'EXPLICIT_CONFIRMATION';

export interface WorkflowCapabilityPrecondition {
  type: WorkflowCapabilityPreconditionType;
  context?: WorkflowContextRequirement;
  artifactKind?: WorkflowArtifactKind;
  provider?: 'github' | 'jira';
}

export type WorkflowCapabilityOutcomeStatus =
  'SUCCESS' | 'NO_RESULT' | 'USER_INPUT_REQUIRED' | 'STALE' | 'FAILED' | 'UNCERTAIN';

export type WorkflowTransitionHint =
  'CONTINUE' | 'SKIP_FIX_BRANCH' | 'REQUIRE_REVISION' | 'PAUSE_CONFIRMATION' | 'PAUSE_USER_INPUT';

export interface WorkflowCapabilityOutcome {
  status: WorkflowCapabilityOutcomeStatus;
  artifact?: WorkflowArtifactRef;
  facts?: WorkflowFact[];
  suggestedTransition?: WorkflowTransitionHint;
  summary?: string;
}

export type WorkflowCostClass = 'LOW' | 'MEDIUM' | 'HIGH';

export interface PlanningCapabilityDescription {
  type: WorkflowStepType;
  purpose: string;
  consumes: WorkflowArtifactKind[];
  produces: WorkflowArtifactKind[];
  requiredContext: WorkflowContextRequirement[];
  executionMode: WorkflowExecutionMode;
  costClass: WorkflowCostClass;
  mutationRisk: WorkflowMutationRisk;
}

export interface PlanningJiraContext {
  issueKey: string;
  summary?: string;
  hasNormalizedIssue: boolean;
  criteriaCount?: number;
}

export interface PlanningGitHubContext {
  repository: string;
  prNumber: number;
  headSha: string;
  hasPrReport: boolean;
  findingCounts?: { high: number; medium: number; low: number };
  writeAccessAvailable?: boolean;
}

export interface PlanningApiContext {
  documentHash: string;
  operationKey?: string;
  hasContractAnalysis: boolean;
}

export interface PlanningCiContext {
  headSha: string;
  overallStatus?: string;
  failedCheckCount: number;
  hasFailureAnalysis: boolean;
}

export interface WorkflowArtifactSummary {
  id: string;
  kind: WorkflowArtifactKind;
  summary?: string;
  status: WorkflowArtifactProvenanceStatus;
  createdAt: string;
}

export interface PlanningPolicySummary {
  maxSteps: number;
  maxWriteCheckpoints: number;
  maxAiCalls: number;
  maxReplans: number;
  writesRequireConfirmation: true;
}

export interface PlanningLimitSummary {
  maxGoalChars: number;
  maxBranchDepth: number;
  maxPlanningRetries: number;
}

export interface PlanningContext {
  goal: DeveloperAgentGoal;
  availableContexts: {
    jira?: PlanningJiraContext;
    github?: PlanningGitHubContext;
    api?: PlanningApiContext;
    ci?: PlanningCiContext;
  };
  availableArtifacts: WorkflowArtifactSummary[];
  capabilities: PlanningCapabilityDescription[];
  policy: PlanningPolicySummary;
  limits: PlanningLimitSummary;
  confidence: AgentPlanConfidence;
  assumptions: string[];
  /** Day 22 — compact project memory for planner prompts. */
  projectMemory?: ProjectMemorySummary;
  /** Day 23 — compact multi-repo system summary for planner prompts. */
  multiRepoSystem?: {
    systemId: string;
    name?: string;
    enabledRepositories: number;
    knownRelationships: string[];
  };
}

export type WorkflowPlanningQuestionType =
  'SELECT_CONTEXT' | 'SELECT_SCOPE' | 'CLARIFY_GOAL' | 'SELECT_TARGET';

export interface PlanningQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface WorkflowPlanningQuestion {
  id: string;
  type: WorkflowPlanningQuestionType;
  question: string;
  options?: PlanningQuestionOption[];
}

export type WorkflowPlanRevisionReason =
  'CONTEXT_CHANGED' | 'NEW_INFORMATION' | 'STEP_FAILED' | 'GOAL_NOT_SATISFIED' | 'USER_REQUEST';

export interface DeveloperWorkflowPlanRevision {
  id: string;
  workflowId: string;
  previousPlanId: string;
  reason: WorkflowPlanRevisionReason;
  preservedCompletedSteps: string[];
  removedRemainingSteps: string[];
  addedSteps: DeveloperWorkflowStep[];
  summary: string;
  requiresApproval: boolean;
  proposedPlan: DeveloperWorkflowPlan;
}

export type WorkflowContextChange =
  | {
      source: 'github';
      kind: 'HEAD_CHANGED';
      previous: string;
      current: string;
    }
  | { source: 'jira'; kind: 'ISSUE_UPDATED' }
  | { source: 'api'; kind: 'DOCUMENT_CHANGED' }
  | { source: 'ci'; kind: 'CHECK_STATE_CHANGED' };

export interface WorkflowExecutionBudget {
  aiCalls: { used: number; max: number };
  providerReads: { used: number; max: number };
  writeCheckpoints: { used: number; max: number };
  replans: { used: number; max: number };
  steps: { used: number; max: number };
}

export type WorkflowGoalOutcomeStatus =
  'ACHIEVED' | 'PARTIALLY_ACHIEVED' | 'NOT_ACHIEVED' | 'CANCELLED' | 'BLOCKED';

export interface WorkflowBlocker {
  code: WorkflowErrorCode;
  message: string;
}

export interface WorkflowGoalOutcome {
  status: WorkflowGoalOutcomeStatus;
  summary: string;
  satisfiedCriteria: string[];
  unsatisfiedCriteria: string[];
  artifacts: WorkflowArtifactRef[];
  blockers?: WorkflowBlocker[];
}

export interface DeveloperWorkflowStep {
  id: string;
  type: WorkflowStepType;
  title: string;
  description: string;
  dependencies: string[];
  requiredContext: WorkflowContextRequirement[];
  executionMode: WorkflowExecutionMode;
  mutationRisk: WorkflowMutationRisk;
  status: WorkflowStepStatus;
  condition?: WorkflowStepCondition;
  /** Concise user-visible reason — never chain-of-thought. */
  reason?: string;
}

export interface DeveloperWorkflowPlan {
  id: string;
  goal: string;
  summary: string;
  steps: DeveloperWorkflowStep[];
  estimatedScope?: {
    aiCalls?: number;
    providerReads?: number;
    writeCheckpoints?: number;
  };
  warnings?: string[];
  assumptions?: string[];
  completionCriteria?: WorkflowCompletionCriterion[];
  confidence?: AgentPlanConfidence;
}

export interface WorkflowStepResult {
  stepId: string;
  status: WorkflowStepStatus;
  startedAt?: string;
  completedAt?: string;
  artifactId?: string;
  summary?: string;
  errorCode?: WorkflowErrorCode;
  errorMessage?: string;
  retryable?: boolean;
}

export type WorkflowArtifactKind =
  | 'engineering-context'
  | 'alignment'
  | 'pr-review'
  | 'finding'
  | 'ci-analysis'
  | 'fix-suggestion'
  | 'generated-patch'
  | 'prepared-patch'
  | 'commit'
  | 'comment-draft'
  | 'review-draft'
  /** Day 23 — multi-repo intelligence artifacts. */
  | 'multi-repo-context'
  | 'change-impact'
  | 'system-flow'
  | 'requirement-coverage'
  | 'cross-repo-compatibility';

export interface WorkflowArtifactRef {
  id: string;
  kind: WorkflowArtifactKind;
  summary?: string;
  createdAt: string;
  binding?: WorkflowContextBinding;
  producedByStepId?: string;
  provenanceStatus?: WorkflowArtifactProvenanceStatus;
}

export interface DeveloperWorkflowSession {
  id: string;
  goal: string;
  agentGoal?: DeveloperAgentGoal;
  createdAt: string;
  updatedAt: string;
  contextBinding: WorkflowContextBinding;
  status: WorkflowSessionStatus;
  plan: DeveloperWorkflowPlan;
  planHistory?: DeveloperWorkflowPlan[];
  pendingRevision?: DeveloperWorkflowPlanRevision;
  planningQuestions?: WorkflowPlanningQuestion[];
  currentStepId?: string;
  stepResults: Record<string, WorkflowStepResult>;
  artifacts: Record<string, WorkflowArtifactRef>;
  facts?: WorkflowFact[];
  budget?: WorkflowExecutionBudget;
  outcome?: WorkflowGoalOutcome;
  execution: {
    startedAt?: string;
    completedAt?: string;
    lastError?: WorkflowErrorBody;
  };
}

/** Safe capability metadata for planner prompts — no handlers. */
export interface PlannerCapabilitySummary {
  type: WorkflowStepType;
  title: string;
  description: string;
  mutationRisk: WorkflowMutationRisk;
  requiredContext: WorkflowContextRequirement[];
  executionMode: WorkflowExecutionMode;
  consumes?: WorkflowArtifactKind[];
  produces?: WorkflowArtifactKind[];
  costClass?: WorkflowCostClass;
}

export type WorkflowPlanValidationResult =
  | { ok: true; plan: DeveloperWorkflowPlan }
  | {
      ok: false;
      code: WorkflowErrorCode;
      message: string;
      details?: Record<string, unknown>;
    };

/** Day 22 — Developer Memory & Project Context budgets. */
export const PROJECT_MEMORY_MAX_ITEMS_PER_REPO = 80;
export const PROJECT_MEMORY_MAX_ACTIVE_USER_RULES = 25;
export const PROJECT_MEMORY_MAX_VALUE_CHARS = 2_000;
export const PROJECT_MEMORY_MAX_SUMMARY_CHARS = 400;
export const PROJECT_MEMORY_MAX_PROVENANCE_ENTRIES = 8;
export const PROJECT_MEMORY_MAX_LEARN_FILES = 36;
export const PROJECT_MEMORY_MAX_LEARN_BYTES = 180_000;
export const PROJECT_MEMORY_MAX_RELEVANT_RULES = 12;

export const ProjectMemoryCategory = {
  ARCHITECTURE: 'ARCHITECTURE',
  FRAMEWORK: 'FRAMEWORK',
  CODE_CONVENTION: 'CODE_CONVENTION',
  NAMING_CONVENTION: 'NAMING_CONVENTION',
  ERROR_HANDLING: 'ERROR_HANDLING',
  API_CONVENTION: 'API_CONVENTION',
  DATABASE_CONVENTION: 'DATABASE_CONVENTION',
  TESTING_CONVENTION: 'TESTING_CONVENTION',
  STATE_MANAGEMENT: 'STATE_MANAGEMENT',
  SECURITY_CONVENTION: 'SECURITY_CONVENTION',
  CI_CONVENTION: 'CI_CONVENTION',
  DEPLOYMENT_CONVENTION: 'DEPLOYMENT_CONVENTION',
  REVIEW_CONVENTION: 'REVIEW_CONVENTION',
  PROJECT_CONSTRAINT: 'PROJECT_CONSTRAINT',
  TECHNICAL_DECISION: 'TECHNICAL_DECISION',
  USER_PREFERENCE: 'USER_PREFERENCE',
  SERVICE_RESPONSIBILITY: 'SERVICE_RESPONSIBILITY',
  DIRECTORY_CONVENTION: 'DIRECTORY_CONVENTION',
  DEPENDENCY_CONVENTION: 'DEPENDENCY_CONVENTION',
} as const;

export type ProjectMemoryCategory =
  (typeof ProjectMemoryCategory)[keyof typeof ProjectMemoryCategory];

export const PROJECT_MEMORY_CATEGORY_VALUES = Object.values(
  ProjectMemoryCategory,
) as ProjectMemoryCategory[];

export type ProjectMemoryConfidence = 'high' | 'medium' | 'low';

export type ProjectMemoryStatus = 'active' | 'superseded' | 'disputed' | 'archived';

export type ProjectMemoryScope =
  | { type: 'repository' }
  | { type: 'directory'; path: string }
  | { type: 'service'; name: string }
  | { type: 'file-pattern'; pattern: string }
  | { type: 'user-project' };

export type ProjectMemoryProvenanceType =
  | 'user_explicit'
  | 'repository_observation'
  | 'workflow_result'
  | 'review_result'
  | 'project_setting';

export interface ProjectMemoryProvenance {
  type: ProjectMemoryProvenanceType;
  sourceId?: string;
  repository?: {
    owner: string;
    name: string;
    headSha?: string;
  };
  filePath?: string;
  observedAt: string;
  summary: string;
}

export type ProjectMemoryFreshnessStrategy =
  'static' | 'config-bound' | 'file-bound' | 'repository-head-sensitive' | 'manual';

export interface ProjectMemoryFreshness {
  strategy: ProjectMemoryFreshnessStrategy;
  lastValidatedAt?: string;
  sourceFingerprint?: string;
}

/** Structured, JSON-serializable memory value — summary is required. */
export interface ProjectMemoryValue {
  summary: string;
  details?: Record<string, unknown>;
}

export interface ProjectMemoryProjectRef {
  provider: 'github';
  owner: string;
  repository: string;
}

/** API-facing memory item — no internal user IDs or secrets. */
export interface ProjectMemoryItem {
  id: string;
  project: ProjectMemoryProjectRef;
  category: ProjectMemoryCategory;
  key: string;
  value: ProjectMemoryValue;
  confidence: ProjectMemoryConfidence;
  status: ProjectMemoryStatus;
  provenance: ProjectMemoryProvenance[];
  scope: ProjectMemoryScope;
  freshness?: ProjectMemoryFreshness;
  supersedesMemoryId?: string;
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt?: string;
}

export type ProjectMemoryCandidateRecommendation = 'auto_accept' | 'ask_user' | 'do_not_store';

export interface ProjectMemoryEvidence {
  filePath?: string;
  summary: string;
  excerpt?: string;
  observedAt?: string;
}

export interface ProjectMemoryCandidate {
  id: string;
  category: ProjectMemoryCategory;
  key: string;
  proposedValue: ProjectMemoryValue;
  evidence: ProjectMemoryEvidence[];
  confidence: ProjectMemoryConfidence;
  recommendation: ProjectMemoryCandidateRecommendation;
  reason: string;
  scope?: ProjectMemoryScope;
}

export interface ProjectProfile {
  project: ProjectMemoryProjectRef;
  architecture: ProjectMemoryItem[];
  conventions: ProjectMemoryItem[];
  constraints: ProjectMemoryItem[];
  tooling: ProjectMemoryItem[];
  preferences: ProjectMemoryItem[];
  generatedAt: string;
  memoryVersion: string;
}

export interface ProjectMemoryRelevantRule {
  id?: string;
  category: ProjectMemoryCategory;
  key: string;
  text: string;
  confidence: ProjectMemoryConfidence;
}

/** Compact planner-facing memory summary. */
export interface ProjectMemorySummary {
  version: string;
  relevantRules: ProjectMemoryRelevantRule[];
}

export interface ProjectConstraintContext {
  noNewDependencies?: boolean;
  rules: { key: string; text: string }[];
}

export type ProjectMemoryErrorCode =
  | 'PROJECT_MEMORY_NOT_INITIALIZED'
  | 'PROJECT_MEMORY_ACCESS_DENIED'
  | 'PROJECT_MEMORY_ITEM_NOT_FOUND'
  | 'PROJECT_MEMORY_VALIDATION_FAILED'
  | 'PROJECT_MEMORY_LIMIT_REACHED'
  | 'PROJECT_MEMORY_CONFLICT'
  | 'PROJECT_MEMORY_CANDIDATE_INVALID'
  | 'PROJECT_MEMORY_EXTRACTION_FAILED'
  | 'PROJECT_MEMORY_SOURCE_UNAVAILABLE'
  | 'PROJECT_MEMORY_STALE'
  | 'PROJECT_MEMORY_SECRET_DETECTED'
  | 'PROJECT_MEMORY_REFRESH_FAILED'
  | 'UNKNOWN';

export interface ProjectMemoryErrorBody {
  code: ProjectMemoryErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface CreateProjectMemoryRuleRequest {
  owner: string;
  repository: string;
  category: ProjectMemoryCategory;
  key?: string;
  text: string;
  scope?: ProjectMemoryScope;
}

export interface UpdateProjectMemoryRequest {
  value?: ProjectMemoryValue;
  status?: ProjectMemoryStatus;
  scope?: ProjectMemoryScope;
  text?: string;
}

export interface LearnProjectMemoryResponse {
  memoryVersion: string;
  profile?: ProjectProfile;
  accepted: ProjectMemoryItem[];
  candidates: ProjectMemoryCandidate[];
  supersededIds?: string[];
}

export interface ListProjectMemoryResponse {
  items: ProjectMemoryItem[];
  memoryVersion: string;
  total: number;
}

export interface ConfirmMemoryCandidateRequest {
  candidateId: string;
  accept: boolean;
  owner?: string;
  repository?: string;
}

/** Day 23 — Multi-Repo Intelligence budgets. */
export const MULTI_REPO_MAX_REPOS_PER_SYSTEM = 10;
export const MULTI_REPO_MAX_REPOS_PER_ANALYSIS = 5;
export const MULTI_REPO_MAX_FILES_PER_REPO = 24;
export const MULTI_REPO_MAX_TOTAL_FILES = 80;
export const MULTI_REPO_MAX_RELATIONSHIPS = 200;
export const MULTI_REPO_MAX_HTTP_OPS = 80;
export const MULTI_REPO_MAX_KAFKA_TOPICS = 80;

export interface RepositoryIdentity {
  provider: 'github';
  owner: string;
  repository: string;
  /** Stable GitHub repository ID when known. */
  repositoryId?: string;
}

export type MultiRepoRepositoryRole =
  | 'frontend'
  | 'backend'
  | 'gateway'
  | 'worker'
  | 'shared-contract'
  | 'library'
  | 'infrastructure'
  | 'unknown';

export type MultiRepoRepositorySource = 'user_selected' | 'project_memory' | 'deterministic_link';

export interface ProjectSystemRepositoryRef {
  id?: string;
  repository: RepositoryIdentity;
  role: MultiRepoRepositoryRole;
  enabled: boolean;
  source: MultiRepoRepositorySource;
  createdAt?: string;
}

export interface ProjectSystem {
  id: string;
  name: string;
  primaryRepository: RepositoryIdentity;
  repositories: ProjectSystemRepositoryRef[];
  createdAt: string;
  updatedAt: string;
}

export type RepositoryRelationshipType =
  | 'HTTP_CALLS'
  | 'PROVIDES_API'
  | 'CONSUMES_API'
  | 'PRODUCES_EVENT'
  | 'CONSUMES_EVENT'
  | 'DEPENDS_ON_PACKAGE'
  | 'PROVIDES_PACKAGE'
  | 'SHARES_CONTRACT'
  | 'DEPLOYMENT_DEPENDENCY'
  | 'UNKNOWN';

export type RelationshipResourceKind =
  'http_operation' | 'kafka_topic' | 'package' | 'schema' | 'service' | 'unknown';

export type RelationshipProvenanceType =
  | 'user_explicit'
  | 'package_reference'
  | 'source_import'
  | 'openapi_reference'
  | 'http_call'
  | 'kafka_producer'
  | 'kafka_consumer'
  | 'documentation'
  | 'workflow_observation';

export interface RelationshipProvenance {
  type: RelationshipProvenanceType;
  repositoryId?: string;
  owner?: string;
  repository?: string;
  filePath?: string;
  commitSha?: string;
  summary: string;
  observedAt: string;
}

export interface RelationshipFreshness {
  lastValidatedAt: string;
  sourceFingerprint?: string;
  sourceCommitSha?: string;
}

export type RelationshipConfidence = 'high' | 'medium' | 'low';

export type RelationshipStatus = 'active' | 'superseded' | 'disputed';

export interface RepositoryRelationship {
  id: string;
  from: RepositoryIdentity;
  to: RepositoryIdentity;
  type: RepositoryRelationshipType;
  resource?: {
    kind: RelationshipResourceKind;
    key: string;
  };
  confidence: RelationshipConfidence;
  provenance: RelationshipProvenance[];
  status: RelationshipStatus;
  freshness?: RelationshipFreshness;
  lastValidatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type RelatedRepositoryRelationship =
  | 'package_dependency'
  | 'api_consumer'
  | 'api_provider'
  | 'event_producer'
  | 'event_consumer'
  | 'shared_contract'
  | 'documentation_reference'
  | 'user_linked'
  | 'unknown';

export interface RelationshipEvidence {
  filePath?: string;
  summary: string;
  excerpt?: string;
  observedAt?: string;
}

export interface RelatedRepositoryCandidate {
  repository: RepositoryIdentity;
  relationship: RelatedRepositoryRelationship;
  confidence: RelationshipConfidence;
  evidence: RelationshipEvidence[];
  recommendation: 'suggest_add' | 'do_not_add';
}

export interface MultiRepoRepositorySummary {
  repository: RepositoryIdentity;
  role: MultiRepoRepositoryRole;
  enabled: boolean;
  available: boolean;
  memoryVersion?: string;
  headSha?: string;
}

export interface MultiRepoHttpResource {
  method: string;
  path: string;
  operationId?: string;
  providerRepository: RepositoryIdentity;
  consumerRepositories?: RepositoryIdentity[];
  evidence?: MultiRepoEvidence[];
}

export interface MultiRepoKafkaResource {
  topic: string;
  eventType?: string;
  producerRepositories?: RepositoryIdentity[];
  consumerRepositories?: RepositoryIdentity[];
  evidence?: MultiRepoEvidence[];
}

export interface MultiRepoContractResource {
  packageName?: string;
  schemaName?: string;
  ownerRepository: RepositoryIdentity;
  dependentRepositories?: RepositoryIdentity[];
  evidence?: MultiRepoEvidence[];
}

export interface MultiRepoArchitectureContext {
  system: {
    id: string;
    name?: string;
  };
  primaryRepository: RepositoryIdentity;
  repositories: MultiRepoRepositorySummary[];
  relationships: RepositoryRelationship[];
  resources: {
    httpOperations: MultiRepoHttpResource[];
    kafkaTopics: MultiRepoKafkaResource[];
    sharedContracts: MultiRepoContractResource[];
  };
  scope: {
    repositoriesRequested: number;
    repositoriesAnalyzed: number;
    repositoriesUnavailable: number;
    filesAnalyzed: number;
    truncated: boolean;
  };
  generatedAt: string;
  version: string;
}

export interface MultiRepoAnalysisScope {
  systemId: string;
  repositoriesAnalyzed: RepositoryIdentity[];
  repositoriesUnavailable?: RepositoryIdentity[];
  filesAnalyzed: number;
  truncated: boolean;
  version?: string;
}

export type MultiRepoEvidenceTrust = 'trusted_metadata' | 'deterministic_source' | 'untrusted_text';

export interface MultiRepoEvidence {
  repository: RepositoryIdentity;
  type:
    | 'file'
    | 'api_operation'
    | 'kafka_topic'
    | 'package'
    | 'project_memory'
    | 'jira'
    | 'pull_request';
  ref: string;
  path?: string;
  line?: number;
  summary: string;
  trust: MultiRepoEvidenceTrust;
}

export type MultiRepoImpactLikelihood = 'high' | 'medium' | 'low' | 'uncertain';

export type MultiRepoImpactType =
  | 'api_consumer'
  | 'api_provider'
  | 'event_consumer'
  | 'event_producer'
  | 'shared_contract'
  | 'library_dependency'
  | 'deployment_dependency'
  | 'unknown';

export type MultiRepoRequiresChange = 'yes' | 'no' | 'not_evident' | 'uncertain';

export interface MultiRepoImpactItem {
  repository: RepositoryIdentity;
  likelihood: MultiRepoImpactLikelihood;
  impactType: MultiRepoImpactType;
  summary: string;
  evidence: MultiRepoEvidence[];
  requiresChange: MultiRepoRequiresChange;
}

export type MultiRepoRiskSeverity = 'high' | 'medium' | 'low';

export interface MultiRepoRisk {
  code: string;
  severity: MultiRepoRiskSeverity;
  summary: string;
  repositories: RepositoryIdentity[];
  evidence: MultiRepoEvidence[];
}

export interface ContractImpactItem {
  kind: 'http' | 'kafka' | 'shared_type' | 'package' | 'unknown';
  key: string;
  changeSummary: string;
  compatibility?: CrossRepoCompatibilityStatus;
  evidence?: MultiRepoEvidence[];
}

export interface MultiRepoCoordinationItem {
  repository: RepositoryIdentity;
  reason: string;
  suggestedAction?: string;
}

export interface MultiRepoNoImpactItem {
  repository: RepositoryIdentity;
  reason: string;
}

export interface MultiRepoChangeImpactAnalysis {
  primaryChange: {
    repository: RepositoryIdentity;
    pullRequestNumber?: number;
    headSha?: string;
    summary: string;
  };
  impactedRepositories: MultiRepoImpactItem[];
  contractImpacts: ContractImpactItem[];
  risks: MultiRepoRisk[];
  requiredCoordination: MultiRepoCoordinationItem[];
  unaffectedOrNotEvident?: MultiRepoNoImpactItem[];
  scope: MultiRepoAnalysisScope;
}

export type SystemFlowNodeType =
  | 'frontend_action'
  | 'http_client'
  | 'api_endpoint'
  | 'service'
  | 'event_producer'
  | 'kafka_topic'
  | 'event_consumer'
  | 'database'
  | 'external_service'
  | 'unknown';

export interface SystemFlowTrigger {
  kind: 'http_operation' | 'kafka_topic' | 'jira' | 'code_symbol' | 'pull_request' | 'unknown';
  key: string;
  repository?: RepositoryIdentity;
  summary?: string;
}

export interface SystemFlowNode {
  id: string;
  type: SystemFlowNodeType;
  label: string;
  repository?: RepositoryIdentity;
  resourceKey?: string;
  confidence?: RelationshipConfidence;
}

export interface SystemFlowEdge {
  fromNodeId: string;
  toNodeId: string;
  kind?: RepositoryRelationshipType | 'sequence';
  label?: string;
  confidence?: RelationshipConfidence;
}

export interface SystemFlowGap {
  afterNodeId?: string;
  summary: string;
  expectedType?: SystemFlowNodeType;
}

export interface SystemFlowTrace {
  trigger: SystemFlowTrigger;
  nodes: SystemFlowNode[];
  edges: SystemFlowEdge[];
  summary: string;
  gaps: SystemFlowGap[];
  scope: MultiRepoAnalysisScope;
}

export type MultiRepoRequirementCoverageStatus =
  'covered' | 'partial' | 'not_evident' | 'conflicting' | 'uncertain';

export interface RepositoryRequirementCoverage {
  repository: RepositoryIdentity;
  status: MultiRepoRequirementCoverageStatus;
  criteria: Array<{
    criterion: string;
    status: MultiRepoRequirementCoverageStatus;
    evidence?: MultiRepoEvidence[];
  }>;
  summary?: string;
}

export interface MultiRepoCoverageGap {
  criterion: string;
  summary: string;
  expectedRepositories?: RepositoryIdentity[];
}

export interface MultiRepoRequirementCoverage {
  issueKey: string;
  repositories: RepositoryRequirementCoverage[];
  endToEndCoverage: MultiRepoRequirementCoverageStatus;
  missingAreas: MultiRepoCoverageGap[];
  scope: MultiRepoAnalysisScope;
}

export type CrossRepoCompatibilityStatus =
  'compatible' | 'potentially_breaking' | 'breaking_evidence' | 'uncertain';

export interface CompatibilityReason {
  code: string;
  summary: string;
  field?: string;
}

export interface CrossRepoCompatibilityResult {
  status: CrossRepoCompatibilityStatus;
  reasons: CompatibilityReason[];
  evidence: MultiRepoEvidence[];
  confidence: RelationshipConfidence;
}

export type MultiRepoErrorCode =
  | 'SYSTEM_CONTEXT_NOT_CONFIGURED'
  | 'SYSTEM_REPOSITORY_LIMIT_REACHED'
  | 'SYSTEM_REPOSITORY_NOT_ACCESSIBLE'
  | 'SYSTEM_CONTEXT_PARTIAL'
  | 'SYSTEM_CONTEXT_STALE'
  | 'RELATED_REPOSITORY_AMBIGUOUS'
  | 'RELATIONSHIP_NOT_FOUND'
  | 'RELATIONSHIP_CONFLICT'
  | 'RELATIONSHIP_STALE'
  | 'MULTI_REPO_CONTEXT_TOO_LARGE'
  | 'MULTI_REPO_SEARCH_LIMIT_REACHED'
  | 'HTTP_CONSUMER_NOT_FOUND'
  | 'EVENT_CONSUMER_NOT_FOUND'
  | 'EVENT_PRODUCER_NOT_FOUND'
  | 'CONTRACT_COMPARISON_FAILED'
  | 'CHANGE_IMPACT_ANALYSIS_FAILED'
  | 'SYSTEM_FLOW_INCOMPLETE'
  | 'MULTI_REPO_ANALYSIS_STALE'
  | 'UNKNOWN';

export interface MultiRepoErrorBody {
  code: MultiRepoErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface CreateProjectSystemRequest {
  name: string;
  primaryOwner: string;
  primaryRepository: string;
  repositories?: Array<{
    owner: string;
    repository: string;
    role?: MultiRepoRepositoryRole;
    enabled?: boolean;
  }>;
}

export interface UpdateProjectSystemRequest {
  name?: string;
  primaryOwner?: string;
  primaryRepository?: string;
}

export interface AddSystemRepositoryRequest {
  owner: string;
  repository: string;
  role?: MultiRepoRepositoryRole;
  enabled?: boolean;
  source?: MultiRepoRepositorySource;
}

export interface UpdateSystemRepositoryRequest {
  role?: MultiRepoRepositoryRole;
  enabled?: boolean;
}

export interface DiscoverRelationshipsResponse {
  systemId: string;
  relationships: RepositoryRelationship[];
  candidates: RelatedRepositoryCandidate[];
  truncated: boolean;
}

export interface AnalyzeChangeImpactRequest {
  systemId: string;
  owner: string;
  repository: string;
  pullRequestNumber?: number;
  headSha?: string;
  summary?: string;
  repositoryIds?: string[];
}

export interface TraceSystemFlowRequest {
  systemId: string;
  trigger: SystemFlowTrigger;
  repositoryIds?: string[];
}

/** Day 24 — Reliability Engine, Audit Trail & Recovery. */

export type WorkflowExecutionTrigger = 'user' | 'retry' | 'resume' | 'replay';

export type WorkflowExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';

export type ExecutionHealthBand = 'Excellent' | 'Good' | 'Warning' | 'Poor' | 'Critical';

export type AuditEventType =
  | 'WORKFLOW_STARTED'
  | 'WORKFLOW_COMPLETED'
  | 'WORKFLOW_FAILED'
  | 'WORKFLOW_CANCELLED'
  | 'PLANNING_STARTED'
  | 'PLANNING_COMPLETED'
  | 'ARTIFACT_CREATED'
  | 'AI_REQUEST_STARTED'
  | 'AI_REQUEST_COMPLETED'
  | 'AI_REQUEST_FAILED'
  | 'GITHUB_WRITE_CONFIRMED'
  | 'GITHUB_WRITE_COMPLETED'
  | 'PATCH_GENERATED'
  | 'PATCH_APPLIED'
  | 'REPLAY_STARTED'
  | 'REPLAY_COMPLETED'
  | 'RESUME_STARTED'
  | 'RESUME_COMPLETED'
  | 'CHECKPOINT_CREATED'
  | 'RETRY_STARTED'
  | 'RETRY_COMPLETED'
  | 'CONTEXT_LOADED'
  | 'FAILURE_RECORDED';

export type ExecutionFailureCategory =
  | 'NETWORK'
  | 'GITHUB'
  | 'JIRA'
  | 'OPENAPI'
  | 'AI_PROVIDER'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'VALIDATION'
  | 'STALE_CONTEXT'
  | 'UNKNOWN';

export type ExecutionCheckpointKind =
  | 'PLANNING_COMPLETE'
  | 'GITHUB_CONTEXT_LOADED'
  | 'OPENAPI_LOADED'
  | 'PROJECT_MEMORY_LOADED'
  | 'MULTI_REPO_LOADED'
  | 'PR_PARSED'
  | 'AI_SUMMARY_COMPLETE'
  | 'PATCH_GENERATED'
  | 'JIRA_LOADED'
  | 'CUSTOM';

export type RetryStageKind =
  | 'AI_FETCH'
  | 'GITHUB_READ'
  | 'JIRA_READ'
  | 'OPENAPI_FETCH'
  | 'GITHUB_WRITE'
  | 'PATCH_APPLY'
  | 'REVIEW_SUBMIT'
  | 'PLANNING'
  | 'OTHER';

export interface ExecutionContextVersion {
  repository?: string;
  prNumber?: number;
  prSha?: string;
  jiraIssueKey?: string;
  jiraUpdatedAt?: string;
  openapiHash?: string;
  openapiDocId?: string;
  memoryVersion?: string;
  systemContextVersion?: string;
  plannerVersion?: string;
  promptVersion?: string;
  promptHash?: string;
  aiModel?: string;
  aiProvider?: string;
}

export interface ExecutionHealthSignals {
  completedStages: number;
  failedStages: number;
  retries: number;
  warnings: number;
  partialFailures: number;
  staleArtifacts: number;
  timeouts: number;
  cancelled: boolean;
}

export interface WorkflowHealthScore {
  score: number;
  band: ExecutionHealthBand;
  signals: ExecutionHealthSignals;
}

export interface PromptVersionRef {
  name: string;
  version: number;
  hash: string;
  createdAt: string;
  capability?: string;
  action?: string;
}

export interface PromptSnapshotRecord {
  id: string;
  name: string;
  version: number;
  hash: string;
  createdAt: string;
  body: string;
  truncated: boolean;
  redacted: boolean;
  capability?: string;
  action?: string;
}

export interface AiRequestAuditSnapshot {
  provider: string;
  model: string;
  temperature?: number;
  promptVersion?: string;
  promptHash?: string;
  memoryVersion?: string;
  systemContextVersion?: string;
  openapiVersion?: string;
  jiraVersion?: string;
  workflowFactsVersion?: string;
  capability?: string;
  inputHash: string;
  outputHash?: string;
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  durationMs?: number;
  status: 'started' | 'completed' | 'failed';
}

export interface WorkflowAuditEvent {
  id: string;
  type: AuditEventType;
  timestamp: string;
  executionId: string;
  workflowId: string;
  stepId?: string;
  artifactId?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowAuditEventInput {
  id: string;
  type: AuditEventType;
  timestamp: string;
  executionId: string;
  workflowId: string;
  stepId?: string;
  artifactId?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionTimelineEvent {
  timestamp: string;
  type: AuditEventType | string;
  label: string;
  message?: string;
  stepId?: string;
  artifactId?: string;
}

export type ExecutionCheckpointState = Record<string, unknown>;

export interface ExecutionCheckpoint {
  id: string;
  kind: ExecutionCheckpointKind;
  label: string;
  createdAt: string;
  stepId?: string;
  state: ExecutionCheckpointState;
}

export interface NormalizedExecutionFailure {
  category: ExecutionFailureCategory;
  retryable: boolean;
  userMessage: string;
  technicalReason: string;
  stage?: string;
  code?: WorkflowErrorCode | string;
  metadata?: Record<string, unknown>;
}

export interface RetryDecision {
  allowed: boolean;
  reason: string;
  requiresConfirmation: boolean;
}

export interface ArtifactLineageNode {
  id: string;
  kind: WorkflowArtifactKind;
  summary?: string;
  producedByStepId?: string;
}

export interface ArtifactLineageEdge {
  fromArtifactId: string;
  toArtifactId: string;
  relation: 'derived_from' | 'produced_before' | 'posted_as';
}

export interface ArtifactLineageGraph {
  nodes: ArtifactLineageNode[];
  edges: ArtifactLineageEdge[];
}

export interface ContextDriftField {
  key:
    | 'prSha'
    | 'openapiHash'
    | 'memoryVersion'
    | 'systemContextVersion'
    | 'jiraUpdatedAt'
    | 'plannerVersion'
    | 'promptVersion'
    | 'aiModel'
    | 'repository'
    | 'jiraIssueKey';
  label: string;
  previous?: string;
  current?: string;
}

export interface ContextDriftSummary {
  hasDrift: boolean;
  fields: ContextDriftField[];
  summary: string;
}

export interface ExecutionSnapshot {
  goal: string;
  constraints?: string[];
  selectedRepositories?: string[];
  workflowCapability?: string;
  checkpointIds: string[];
  artifactRefs: WorkflowArtifactRef[];
  trigger?: WorkflowExecutionTrigger;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  executionNumber: number;
  trigger: WorkflowExecutionTrigger;
  startedAt: string;
  completedAt?: string;
  status: WorkflowExecutionStatus;
  healthScore: number;
  healthBand: ExecutionHealthBand;
  durationMs?: number;
  contextVersion: ExecutionContextVersion;
  parentExecutionId?: string;
  goal?: string;
  resumeAvailable: boolean;
  replayAvailable: boolean;
  artifactCount: number;
  failureCount: number;
  retryCount: number;
  promptVersion?: PromptVersionRef;
}

export interface WorkflowExecutionDetail extends WorkflowExecution {
  timeline: ExecutionTimelineEvent[];
  checkpoints: ExecutionCheckpoint[];
  failures: NormalizedExecutionFailure[];
  lineage: ArtifactLineageGraph;
  snapshot?: ExecutionSnapshot;
  aiRequests: AiRequestAuditSnapshot[];
  events: WorkflowAuditEvent[];
  health: WorkflowHealthScore;
}

export interface StartWorkflowExecutionRequest {
  workflowId: string;
  goal: string;
  trigger?: WorkflowExecutionTrigger;
  parentExecutionId?: string;
  contextVersion?: ExecutionContextVersion;
  constraints?: string[];
  selectedRepositories?: string[];
  workflowCapability?: string;
  promptName?: string;
  promptBody?: string;
  capability?: string;
  action?: string;
}

export interface AppendAuditEventRequest {
  type: AuditEventType;
  stepId?: string;
  artifactId?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export interface CreateCheckpointRequest {
  kind: ExecutionCheckpointKind;
  label: string;
  stepId?: string;
  state?: ExecutionCheckpointState;
}

export interface RecordFailureRequest {
  code?: string;
  message?: string;
  httpStatus?: number;
  stage?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordAiRequestRequest {
  status: 'started' | 'completed' | 'failed';
  provider: string;
  model: string;
  temperature?: number;
  capability?: string;
  /** Prompt registry name — preferably `prompt-registry:${AIAction}`. */
  promptName?: string;
  action?: string;
  promptBody?: string;
  inputParts?: string[];
  outputText?: string;
  tokenUsage?: AiRequestAuditSnapshot['tokenUsage'];
  durationMs?: number;
  memoryVersion?: string;
  systemContextVersion?: string;
  openapiVersion?: string;
  jiraVersion?: string;
  workflowFactsVersion?: string;
}

export interface RecordArtifactLineageRequest {
  artifacts: Array<{
    id: string;
    kind: WorkflowArtifactKind;
    summary?: string;
    parentArtifactId?: string;
    producedByStepId?: string;
  }>;
}

export interface CompleteExecutionRequest {
  status: 'completed' | 'failed' | 'cancelled' | 'stale';
  healthSignals?: Partial<ExecutionHealthSignals>;
  snapshotArtifacts?: WorkflowArtifactRef[];
}

export interface ReplayPreviewRequest {
  currentContext?: ExecutionContextVersion;
}

export interface ReplayPreviewResponse {
  executionId: string;
  drift: ContextDriftSummary;
  canReplay: boolean;
  requiresWriteConfirmation: boolean;
}

export interface ResumeExecutionResponse {
  execution: WorkflowExecution;
  checkpoint: ExecutionCheckpoint;
  skipCompletedThrough: string;
}

export interface RetryExecutionRequest {
  stage: RetryStageKind;
  category: ExecutionFailureCategory;
  attempt?: number;
  writeConfirmed?: boolean;
  idempotentSafe?: boolean;
}

export interface RetryExecutionResponse {
  decision: RetryDecision;
  execution?: WorkflowExecution;
}

export type ReliabilityErrorCode =
  | 'EXECUTION_NOT_FOUND'
  | 'CHECKPOINT_NOT_FOUND'
  | 'RESUME_NOT_AVAILABLE'
  | 'REPLAY_NOT_AVAILABLE'
  | 'RETRY_NOT_ALLOWED'
  | 'AUDIT_LIMIT_REACHED'
  | 'INVALID_EXECUTION_STATE'
  | 'UNKNOWN';

export interface ReliabilityErrorBody {
  code: ReliabilityErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ListWorkflowExecutionsResponse {
  executions: WorkflowExecution[];
}
