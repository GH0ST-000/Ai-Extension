import {
  MULTI_REPO_MAX_FILE_BYTES,
  MULTI_REPO_MAX_SCAN_BYTES,
  MULTI_REPO_MAX_TREE_ENTRIES,
  type MultiRepoScanIssueCode,
} from '@project-x/types';
import { planRepositoryScan, type TreeEntry } from '@project-x/shared';

/**
 * Reads a bounded, relevant subset of one GitHub repository for relationship discovery.
 *
 * Requests (all to api.github.com, token from the user's own connection):
 *   1. GET /repos/{o}/{r}                         — access check + default branch
 *   2. GET /repos/{o}/{r}/git/trees/HEAD?recursive=1 (+ the root tree when truncated)
 *   3. GET /repos/{o}/{r}/git/blobs/{sha}          — selected files, by tree SHA
 * Every request counts against one per-analysis budget; bytes against one byte budget.
 * Failures are categorized (never silently dropped) and a rate limit stops all further reads.
 * File contents and tokens are never logged.
 */

export interface ScannedFile {
  path: string;
  content: string;
}

export interface RepositoryScanResult {
  status: 'complete' | 'partial' | 'unavailable';
  branch?: string;
  files: ScannedFile[];
  issues: Map<MultiRepoScanIssueCode, number>;
}

type Failure =
  'not_found' | 'repository_inaccessible' | 'token_invalid' | 'rate_limited' | 'github_error';

const API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;
const CONCURRENCY = 4;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Shared across all repositories of one analysis. */
export class ScanBudget {
  requests = 0;
  bytes = 0;
  /** Set on rate limit / revoked token: no further GitHub requests in this analysis. */
  halted: Failure | null = null;

  constructor(
    readonly maxRequests: number,
    readonly maxBytes: number = MULTI_REPO_MAX_SCAN_BYTES,
  ) {}

  take(): boolean {
    if (this.halted || this.requests >= this.maxRequests) return false;
    this.requests += 1;
    return true;
  }
}

export function classifyGithubResponse(status: number, headers: Headers): Failure {
  if (status === 429) return 'rate_limited';
  if (
    status === 403 &&
    (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after'))
  ) {
    return 'rate_limited';
  }
  if (status === 401) return 'token_invalid';
  if (status === 404) return 'not_found';
  if (status === 403) return 'repository_inaccessible';
  return 'github_error';
}

export class RepositoryScanner {
  constructor(
    private readonly token: string,
    readonly budget: ScanBudget,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async getJson(
    url: string,
  ): Promise<{ ok: true; body: unknown } | { ok: false; failure: Failure | 'budget' }> {
    if (!this.budget.take()) return { ok: false, failure: this.budget.halted ?? 'budget' };
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'User-Agent': 'Project-X',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, failure: 'github_error' };
    }
    if (!response.ok) {
      const failure = classifyGithubResponse(response.status, response.headers);
      if (failure === 'rate_limited' || failure === 'token_invalid') this.budget.halted = failure;
      return { ok: false, failure };
    }
    try {
      return { ok: true, body: (await response.json()) as unknown };
    } catch {
      return { ok: false, failure: 'github_error' };
    }
  }

  async scan(owner: string, repository: string, maxFiles: number): Promise<RepositoryScanResult> {
    const issues = new Map<MultiRepoScanIssueCode, number>();
    const note = (code: MultiRepoScanIssueCode, n = 1) =>
      issues.set(code, (issues.get(code) ?? 0) + n);
    const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
    const fail = (failure: Failure | 'budget'): MultiRepoScanIssueCode =>
      failure === 'budget'
        ? 'request_budget_reached'
        : failure === 'not_found'
          ? 'repository_inaccessible'
          : failure;

    // 1. Repository metadata (access + default branch).
    const meta = await this.getJson(base);
    if (!meta.ok) {
      note(fail(meta.failure));
      return {
        status: meta.failure === 'budget' ? 'partial' : 'unavailable',
        files: [],
        issues,
      };
    }
    const branchRaw = (meta.body as { default_branch?: unknown }).default_branch;
    const branch = typeof branchRaw === 'string' ? branchRaw.slice(0, 255) : undefined;

    // 2. Tree of the default branch (HEAD).
    const tree = await this.getJson(`${base}/git/trees/HEAD?recursive=1`);
    if (!tree.ok) {
      note(fail(tree.failure));
      return { status: 'partial', ...(branch ? { branch } : {}), files: [], issues };
    }
    const body = tree.body as { tree?: unknown; truncated?: unknown };
    let entries = Array.isArray(body.tree) ? (body.tree as TreeEntry[]) : [];
    let truncated = body.truncated === true;
    if (entries.length > MULTI_REPO_MAX_TREE_ENTRIES) {
      entries = entries.slice(0, MULTI_REPO_MAX_TREE_ENTRIES);
      truncated = true;
    }
    if (truncated) {
      note('tree_truncated');
      // A truncated recursive listing may miss root files: list the root explicitly.
      const root = await this.getJson(`${base}/git/trees/HEAD`);
      if (root.ok && Array.isArray((root.body as { tree?: unknown }).tree)) {
        const known = new Set(entries.map((e) => e.path));
        for (const e of (root.body as { tree: TreeEntry[] }).tree) {
          if (!known.has(e.path)) entries.push(e);
        }
      }
    }

    // 3. Choose and read files.
    const plan = planRepositoryScan(entries, Math.max(0, maxFiles), MULTI_REPO_MAX_FILE_BYTES);
    if (plan.oversized > 0) note('file_too_large', plan.oversized);
    if (plan.overBudget > 0) note('file_budget_reached', plan.overBudget);

    const files: ScannedFile[] = [];
    const queue = plan.selected.filter((e) => typeof e.sha === 'string' && SHA_RE.test(e.sha));
    const worker = async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        const size = typeof entry.size === 'number' ? entry.size : 0;
        if (this.budget.bytes + size > this.budget.maxBytes) {
          note('byte_budget_reached');
          continue;
        }
        // Reserve before the request so concurrent workers cannot overshoot the byte budget.
        this.budget.bytes += size;
        const blob = await this.getJson(`${base}/git/blobs/${entry.sha}`);
        if (!blob.ok) {
          this.budget.bytes -= size;
          note(
            blob.failure === 'not_found' || blob.failure === 'github_error'
              ? 'file_unreadable'
              : fail(blob.failure),
          );
          continue;
        }
        const { content, encoding } = blob.body as { content?: unknown; encoding?: unknown };
        if (typeof content !== 'string' || encoding !== 'base64') {
          note('file_unreadable');
          continue;
        }
        const text = Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8');
        const bytes = Buffer.byteLength(text, 'utf8');
        this.budget.bytes += bytes - size;
        if (bytes > MULTI_REPO_MAX_FILE_BYTES) {
          note('file_too_large');
          continue;
        }
        if (text.includes('\u0000')) continue; // binary
        files.push({ path: entry.path, content: text });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      status: issues.size > 0 ? 'partial' : 'complete',
      ...(branch ? { branch } : {}),
      files,
      issues,
    };
  }
}
