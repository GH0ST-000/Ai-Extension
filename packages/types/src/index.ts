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
