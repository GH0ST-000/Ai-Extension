import { Injectable, Logger } from '@nestjs/common';
import { AIAction } from '@project-x/types';
import type {
  AnalyzeCIFailureRequest,
  AnalyzeCIFailureResponse,
  CICheckFailureEvidence,
  CIEvidenceCapability,
  CINormalizedCheck,
  PullRequestCISummary,
} from '@project-x/types';
import { CI_MAX_LOG_BYTES } from '@project-x/types';

import { AiService } from '../ai/ai.service';
import { GithubConnectionService } from '../settings/github-connection.service';
import { GithubErrorNormalizer } from './github-error-normalizer';
import { normalizeRepositoryPath } from './patch-path';
import { parseCIFailureAnalysisJson } from './ci/ci-analysis-parse';
import {
  boundLogForUi,
  buildCIFailureAnalysisContext,
  normalizeAnnotations,
} from './ci/ci-context-budget';
import { isSafeHttpsUrl, isTrustedGitHubDetailsUrl } from './ci/ci-log-sanitize';
import {
  computeCheckCounts,
  computeOverallStatus,
  formatCheckRunId,
  formatStatusId,
  isFailedConclusion,
  normalizeCheckConclusion,
  normalizeCheckRunStatus,
  normalizeCommitStatusState,
  parseCheckProviderId,
} from './ci/ci-status';

type GitHubPullResponse = {
  number?: number;
  title?: string;
  head?: { sha?: string; ref?: string };
  message?: string;
};

type GitHubCheckRun = {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string | null;
  details_url?: string | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null };
  app?: { name?: string | null; slug?: string | null };
  check_suite?: { id?: number };
};

type GitHubCheckRunsResponse = {
  check_runs?: GitHubCheckRun[];
  message?: string;
};

type GitHubStatusItem = {
  context?: string;
  state?: string;
  description?: string | null;
  target_url?: string | null;
  created_at?: string;
  updated_at?: string;
  creator?: { login?: string };
};

type GitHubCombinedStatusResponse = {
  statuses?: GitHubStatusItem[];
  message?: string;
};

type GitHubAnnotationsResponse = Array<{
  path?: string;
  start_line?: number;
  end_line?: number;
  annotation_level?: string;
  title?: string;
  message?: string;
  raw_details?: string;
}>;

@Injectable()
export class GithubCiService {
  private readonly logger = new Logger(GithubCiService.name);

  constructor(
    private readonly githubConnections: GithubConnectionService,
    private readonly errors: GithubErrorNormalizer,
    private readonly aiService: AiService,
  ) {}

  async listPullRequestChecks(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    pullRequestNumber: number,
  ): Promise<PullRequestCISummary> {
    const owner = ownerRaw.trim();
    const repository = repositoryRaw.trim();
    this.assertPrIdentity(owner, repository, pullRequestNumber);

    const token = await this.requireToken(userId);
    const pull = await this.fetchPullRequest({ token, owner, repository, pullRequestNumber });
    const headSha = pull.head?.sha?.trim();
    if (!headSha) {
      throw this.errors.toHttpException(
        'PULL_REQUEST_NOT_FOUND',
        'GitHub did not return a head SHA for this pull request.',
      );
    }

    let partialData = false;
    let checkRuns: GitHubCheckRun[] = [];
    let statuses: GitHubStatusItem[] = [];

    try {
      checkRuns = await this.fetchCheckRuns({ token, owner, repository, headSha });
    } catch (error) {
      this.logger.warn({
        msg: 'ci.check_runs.failed',
        owner,
        repository,
        headSha: headSha.slice(0, 7),
      });
      if (error instanceof Error && 'getStatus' in error) {
        throw error;
      }
      partialData = true;
    }

    try {
      statuses = await this.fetchCommitStatuses({ token, owner, repository, headSha });
    } catch {
      this.logger.warn({ msg: 'ci.commit_statuses.failed', owner, repository });
      partialData = true;
    }

    if (checkRuns.length === 0 && statuses.length === 0 && !partialData) {
      // Empty is valid (no checks yet).
    }

    const checks = this.mergeNormalizedChecks(checkRuns, statuses);
    const fetchedAt = new Date().toISOString();

    return {
      owner,
      repository,
      pullRequestNumber,
      headSha,
      overallStatus: computeOverallStatus(checks),
      counts: computeCheckCounts(checks),
      checks,
      fetchedAt,
      partialData: partialData || undefined,
    };
  }

  async getCheckFailureEvidence(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    pullRequestNumber: number,
    checkId: string,
  ): Promise<CICheckFailureEvidence> {
    const owner = ownerRaw.trim();
    const repository = repositoryRaw.trim();
    this.assertPrIdentity(owner, repository, pullRequestNumber);

    const token = await this.requireToken(userId);
    const pull = await this.fetchPullRequest({ token, owner, repository, pullRequestNumber });
    const headSha = pull.head?.sha?.trim();
    if (!headSha) {
      throw this.errors.toHttpException(
        'PULL_REQUEST_NOT_FOUND',
        'GitHub did not return a head SHA for this pull request.',
      );
    }

    const parsed = parseCheckProviderId(checkId);
    if (!parsed) {
      throw this.errors.toHttpException('CHECK_NOT_FOUND', 'Unknown check identifier.');
    }

    if (parsed.kind === 'status') {
      const statuses = await this.fetchCommitStatuses({ token, owner, repository, headSha });
      const match = statuses.find((s) => (s.context ?? '') === parsed.context);
      if (!match) {
        throw this.errors.toHttpException(
          'CHECK_NOT_FOUND',
          'That commit status was not found on the current PR head.',
        );
      }
      const check = this.normalizeStatusCheck(match);
      const summaryText = match.description?.trim() || undefined;
      const evidenceItems = summaryText
        ? [
            {
              source: 'check_summary' as const,
              label: 'Status description',
              excerpt: summaryText,
            },
          ]
        : [];

      return {
        owner,
        repository,
        pullRequestNumber,
        headSha,
        check,
        summaryText,
        annotations: [],
        evidence: evidenceItems,
        truncated: false,
        redacted: false,
        logsUnavailable: true,
        fetchedAt: new Date().toISOString(),
      };
    }

    const run = await this.fetchCheckRun({ token, owner, repository, runId: parsed.runId });
    const check = this.normalizeCheckRun(run);
    if (!check) {
      throw this.errors.toHttpException('CHECK_NOT_FOUND', 'That check run was not found.');
    }

    let annotationsTruncated = false;
    let annotations: ReturnType<typeof normalizeAnnotations>['annotations'] = [];
    try {
      const rawAnnotations = await this.fetchCheckAnnotations({
        token,
        owner,
        repository,
        runId: parsed.runId,
      });
      const normalized = normalizeAnnotations(rawAnnotations);
      annotations = normalized.annotations;
      annotationsTruncated = normalized.truncated;
    } catch {
      // Annotations optional
    }

    const summaryParts = [run.output?.title, run.output?.summary, run.output?.text]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .join('\n\n');

    let logExcerpt: string | undefined;
    let logsUnavailable = false;
    let logTruncated = false;
    let redacted = false;

    const wantsLogs =
      isFailedConclusion(check.conclusion) &&
      annotations.length === 0 &&
      this.looksLikeGitHubActions(check);

    if (wantsLogs) {
      try {
        const jobId = await this.resolveActionsJobId({
          token,
          owner,
          repository,
          checkRun: run,
          headSha,
        });
        if (jobId) {
          const rawLog = await this.fetchActionsJobLogsBounded({
            token,
            owner,
            repository,
            jobId,
          });
          if (rawLog) {
            const bound = boundLogForUi(rawLog);
            logExcerpt = bound.text;
            logTruncated = bound.truncated;
            redacted = bound.redacted;
          } else {
            logsUnavailable = true;
          }
        } else {
          logsUnavailable = true;
        }
      } catch {
        logsUnavailable = true;
      }
    } else if (isFailedConclusion(check.conclusion) && !this.looksLikeGitHubActions(check)) {
      logsUnavailable = annotations.length === 0 && !summaryParts;
    }

    const context = buildCIFailureAnalysisContext({
      owner,
      repository,
      pullRequestNumber,
      headSha,
      check,
      summaryText: summaryParts || undefined,
      annotations,
      logText: logExcerpt,
    });

    return {
      owner,
      repository,
      pullRequestNumber,
      headSha,
      check,
      summaryText: summaryParts || undefined,
      annotations,
      logExcerpt,
      evidence: context.evidence,
      truncated: annotationsTruncated || logTruncated || context.truncated,
      redacted: redacted || context.redacted,
      logsUnavailable: logsUnavailable || undefined,
      fetchedAt: new Date().toISOString(),
    };
  }

  async analyzeCheckFailure(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    pullRequestNumber: number,
    checkId: string,
    body: AnalyzeCIFailureRequest,
  ): Promise<AnalyzeCIFailureResponse> {
    const evidence = await this.getCheckFailureEvidence(
      userId,
      ownerRaw,
      repositoryRaw,
      pullRequestNumber,
      checkId,
    );

    if (body.expectedHeadSha?.trim() && body.expectedHeadSha.trim() !== evidence.headSha) {
      throw this.errors.toHttpException(
        'STALE_CI_CONTEXT',
        'The pull request changed while this CI result was being analyzed. Refresh the CI status.',
      );
    }

    if (!isFailedConclusion(evidence.check.conclusion) && evidence.check.status === 'COMPLETED') {
      // Allow analysis of failed-like only; pending has little value
      if (evidence.check.conclusion === 'SUCCESS') {
        throw this.errors.toHttpException(
          'CHECK_DETAILS_UNAVAILABLE',
          'Detailed failure information is not available for this check.',
        );
      }
    }

    const changedFiles = (body.changedFiles ?? [])
      .map((f) => {
        const path = normalizeRepositoryPath(f.path);
        return path ? { path } : null;
      })
      .filter((f): f is { path: string } => f != null);

    const analysisContext = buildCIFailureAnalysisContext({
      owner: evidence.owner,
      repository: evidence.repository,
      pullRequestNumber: evidence.pullRequestNumber,
      headSha: evidence.headSha,
      pullRequestTitle: body.pullRequestTitle,
      check: evidence.check,
      summaryText: evidence.summaryText,
      annotations: evidence.annotations,
      logText: evidence.logExcerpt,
      changedFiles,
    });

    let raw: string;
    try {
      raw = await this.aiService.generateAction(userId, {
        action: AIAction.ANALYZE_CI_FAILURE,
        text: analysisContext.promptText,
      });
    } catch {
      throw this.errors.toHttpException(
        'AI_ANALYSIS_FAILED',
        'Unable to analyze this CI failure. Try again.',
      );
    }

    let analysis;
    try {
      analysis = parseCIFailureAnalysisJson(raw, {
        owner: evidence.owner,
        repository: evidence.repository,
        pullRequestNumber: evidence.pullRequestNumber,
        headSha: evidence.headSha,
        checkId: evidence.check.id,
        evidence: analysisContext.evidence,
        evidenceTruncated: analysisContext.truncated || Boolean(evidence.truncated),
        trustedChangedPaths: analysisContext.changedFilePaths,
      });
    } catch {
      throw this.errors.toHttpException(
        'AI_ANALYSIS_FAILED',
        'Unable to analyze this CI failure. Try again.',
      );
    }

    return {
      analysis,
      evidence: {
        ...evidence,
        evidence: analysisContext.evidence,
        truncated: analysisContext.truncated || evidence.truncated,
        redacted: analysisContext.redacted || evidence.redacted,
      },
    };
  }

  private assertPrIdentity(owner: string, repository: string, pullRequestNumber: number): void {
    if (!owner || !repository || owner === 'unknown' || repository === 'unknown') {
      throw this.errors.toHttpException('PULL_REQUEST_NOT_FOUND', 'Missing GitHub PR identity.');
    }
    if (!Number.isFinite(pullRequestNumber) || pullRequestNumber < 1) {
      throw this.errors.toHttpException('PULL_REQUEST_NOT_FOUND', 'Missing GitHub PR identity.');
    }
  }

  private async requireToken(userId: string): Promise<string> {
    const token = await this.githubConnections.getDecryptedToken(userId);
    if (!token) {
      throw this.errors.toHttpException(
        'NOT_CONNECTED',
        'Connect a GitHub token in dashboard Settings before viewing CI status.',
      );
    }
    return token;
  }

  private githubHeaders(token: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Project-X',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private async fetchPullRequest(input: {
    token: string;
    owner: string;
    repository: string;
    pullRequestNumber: number;
  }): Promise<GitHubPullResponse> {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.pullRequestNumber}`;
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.githubHeaders(input.token) });
    } catch {
      throw this.errors.toHttpException(
        'GITHUB_UNAVAILABLE',
        'Unable to reach GitHub to validate the pull request.',
      );
    }
    const payload = (await response.json().catch(() => ({}))) as GitHubPullResponse;
    if (!response.ok) {
      throw this.errors.fromGitHubStatus(response.status, payload.message, 'ci');
    }
    return payload;
  }

  private async fetchCheckRuns(input: {
    token: string;
    owner: string;
    repository: string;
    headSha: string;
  }): Promise<GitHubCheckRun[]> {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/commits/${encodeURIComponent(input.headSha)}/check-runs?per_page=100`;
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.githubHeaders(input.token) });
    } catch {
      throw this.errors.toHttpException(
        'GITHUB_UNAVAILABLE',
        'Unable to reach GitHub to load check runs.',
      );
    }
    const payload = (await response.json().catch(() => ({}))) as GitHubCheckRunsResponse;
    if (!response.ok) {
      throw this.errors.fromGitHubStatus(response.status, payload.message, 'ci');
    }
    return payload.check_runs ?? [];
  }

  private async fetchCommitStatuses(input: {
    token: string;
    owner: string;
    repository: string;
    headSha: string;
  }): Promise<GitHubStatusItem[]> {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/commits/${encodeURIComponent(input.headSha)}/status`;
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.githubHeaders(input.token) });
    } catch {
      throw this.errors.toHttpException(
        'GITHUB_UNAVAILABLE',
        'Unable to reach GitHub to load commit statuses.',
      );
    }
    const payload = (await response.json().catch(() => ({}))) as GitHubCombinedStatusResponse;
    if (!response.ok) {
      throw this.errors.fromGitHubStatus(response.status, payload.message, 'ci');
    }
    return payload.statuses ?? [];
  }

  private async fetchCheckRun(input: {
    token: string;
    owner: string;
    repository: string;
    runId: number;
  }): Promise<GitHubCheckRun> {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/check-runs/${input.runId}`;
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.githubHeaders(input.token) });
    } catch {
      throw this.errors.toHttpException(
        'GITHUB_UNAVAILABLE',
        'Unable to reach GitHub to load this check.',
      );
    }
    const payload = (await response.json().catch(() => ({}))) as GitHubCheckRun & {
      message?: string;
    };
    if (response.status === 404) {
      throw this.errors.toHttpException('CHECK_NOT_FOUND', 'That check run was not found.');
    }
    if (!response.ok) {
      throw this.errors.fromGitHubStatus(response.status, payload.message, 'ci');
    }
    return payload;
  }

  private async fetchCheckAnnotations(input: {
    token: string;
    owner: string;
    repository: string;
    runId: number;
  }): Promise<GitHubAnnotationsResponse> {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/check-runs/${input.runId}/annotations?per_page=50`;
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.githubHeaders(input.token) });
    } catch {
      return [];
    }
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json().catch(() => [])) as GitHubAnnotationsResponse;
    return Array.isArray(payload) ? payload : [];
  }

  private looksLikeGitHubActions(check: CINormalizedCheck): boolean {
    const source = (check.source ?? '').toLowerCase();
    const url = check.detailsUrl ?? '';
    return (
      source.includes('github actions') ||
      source === 'github-actions' ||
      url.includes('/actions/runs/') ||
      (url.includes('github.com') && url.includes('/job/'))
    );
  }

  private async resolveActionsJobId(input: {
    token: string;
    owner: string;
    repository: string;
    checkRun: GitHubCheckRun;
    headSha: string;
  }): Promise<number | null> {
    const details = input.checkRun.details_url ?? input.checkRun.html_url ?? '';
    const jobMatch = details.match(/\/actions\/runs\/\d+\/job\/(\d+)/);
    if (jobMatch?.[1]) {
      return Number.parseInt(jobMatch[1], 10);
    }

    // Fallback: list jobs for the commit and match by name
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/commits/${encodeURIComponent(input.headSha)}/check-runs?per_page=1`;
    void url;
    const runsUrl = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/actions/runs?head_sha=${encodeURIComponent(input.headSha)}&per_page=10`;
    let response: Response;
    try {
      response = await fetch(runsUrl, { method: 'GET', headers: this.githubHeaders(input.token) });
    } catch {
      return null;
    }
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json().catch(() => ({}))) as {
      workflow_runs?: Array<{ id?: number }>;
    };
    const runId = payload.workflow_runs?.[0]?.id;
    if (!runId) {
      return null;
    }

    const jobsUrl = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/actions/runs/${runId}/jobs?per_page=100`;
    let jobsResponse: Response;
    try {
      jobsResponse = await fetch(jobsUrl, {
        method: 'GET',
        headers: this.githubHeaders(input.token),
      });
    } catch {
      return null;
    }
    if (!jobsResponse.ok) {
      return null;
    }
    const jobsPayload = (await jobsResponse.json().catch(() => ({}))) as {
      jobs?: Array<{ id?: number; name?: string; check_run_url?: string }>;
    };
    const name = input.checkRun.name ?? '';
    const match =
      jobsPayload.jobs?.find((j) => j.name === name) ??
      jobsPayload.jobs?.find((j) => j.check_run_url?.includes(String(input.checkRun.id)));
    return match?.id ?? null;
  }

  /**
   * Download Actions job logs via authenticated GitHub API only.
   * Follows the official redirect; never returns signed URLs to clients.
   */
  private async fetchActionsJobLogsBounded(input: {
    token: string;
    owner: string;
    repository: string;
    jobId: number;
  }): Promise<string | null> {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/actions/jobs/${input.jobId}/logs`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.githubHeaders(input.token),
        redirect: 'manual',
      });
    } catch {
      return null;
    }

    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get('location');
      if (!location || !isSafeHttpsUrl(location)) {
        return null;
      }
      // Only follow redirects to GitHub-controlled hosts
      if (!isTrustedGitHubDetailsUrl(location) && !location.includes('githubusercontent.com')) {
        return null;
      }
      try {
        response = await fetch(location, {
          method: 'GET',
          redirect: 'follow',
          headers: { 'User-Agent': 'Project-X' },
        });
      } catch {
        return null;
      }
    }

    if (!response.ok) {
      return null;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      return text.slice(0, CI_MAX_LOG_BYTES);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < CI_MAX_LOG_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      const remaining = CI_MAX_LOG_BYTES - total;
      if (value.byteLength <= remaining) {
        chunks.push(value);
        total += value.byteLength;
      } else {
        chunks.push(value.slice(0, remaining));
        total += remaining;
        break;
      }
    }
    await reader.cancel().catch(() => undefined);

    const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return merged.toString('utf8');
  }

  private mergeNormalizedChecks(
    checkRuns: GitHubCheckRun[],
    statuses: GitHubStatusItem[],
  ): CINormalizedCheck[] {
    const checks: CINormalizedCheck[] = [];
    const seenNames = new Set<string>();

    for (const run of checkRuns) {
      const normalized = this.normalizeCheckRun(run);
      if (normalized) {
        checks.push(normalized);
        seenNames.add(normalized.name.toLowerCase());
      }
    }

    for (const status of statuses) {
      const context = status.context?.trim();
      if (!context) {
        continue;
      }
      // Skip statuses that duplicate a check run with the same name
      if (seenNames.has(context.toLowerCase())) {
        continue;
      }
      checks.push(this.normalizeStatusCheck(status));
    }

    return checks;
  }

  private normalizeCheckRun(run: GitHubCheckRun): CINormalizedCheck | null {
    if (typeof run.id !== 'number' || !run.name?.trim()) {
      return null;
    }
    const status = normalizeCheckRunStatus(run.status);
    const conclusion = normalizeCheckConclusion(run.conclusion);
    const detailsRaw = run.details_url || run.html_url || undefined;
    const detailsUrl = isSafeHttpsUrl(detailsRaw) ?? undefined;
    const source = run.app?.name?.trim() || run.app?.slug?.trim() || undefined;

    const capabilities: CIEvidenceCapability[] = ['STATUS_ONLY'];
    if (run.output?.summary || run.output?.text || run.output?.title) {
      capabilities.push('SUMMARY');
    }
    capabilities.push('ANNOTATIONS');
    const looksActions =
      (source ?? '').toLowerCase().includes('github actions') ||
      (detailsUrl ?? '').includes('/actions/');
    if (looksActions) {
      capabilities.push('ACTIONS_LOGS');
    }
    if (detailsUrl && !looksActions) {
      capabilities.push('EXTERNAL_LINK');
    }

    const canInspectDetails =
      isFailedConclusion(conclusion) ||
      status === 'IN_PROGRESS' ||
      status === 'QUEUED' ||
      status === 'WAITING';

    return {
      id: formatCheckRunId(run.id),
      name: run.name.trim(),
      source,
      status,
      conclusion,
      startedAt: run.started_at ?? undefined,
      completedAt: run.completed_at ?? undefined,
      detailsUrl,
      canInspectDetails: Boolean(canInspectDetails),
      evidenceCapabilities: capabilities,
    };
  }

  private normalizeStatusCheck(status: GitHubStatusItem): CINormalizedCheck {
    const context = status.context?.trim() || 'status';
    const { status: runStatus, conclusion } = normalizeCommitStatusState(status.state);
    const detailsUrl = isSafeHttpsUrl(status.target_url) ?? undefined;
    const capabilities: CIEvidenceCapability[] = ['STATUS_ONLY'];
    if (status.description) {
      capabilities.push('SUMMARY');
    }
    if (detailsUrl) {
      capabilities.push('EXTERNAL_LINK');
    }

    return {
      id: formatStatusId(context),
      name: context,
      source: status.creator?.login ? `status:${status.creator.login}` : 'commit-status',
      status: runStatus,
      conclusion,
      startedAt: status.created_at,
      completedAt: status.updated_at,
      detailsUrl,
      canInspectDetails: isFailedConclusion(conclusion) || runStatus !== 'COMPLETED',
      evidenceCapabilities: capabilities,
    };
  }
}
