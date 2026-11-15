/**
 * Deterministic classification and prioritization of PR changed files. Nothing here calls
 * the network or the model: the same input always yields the same order and statuses.
 */

/** GitHub `GET /pulls/{n}/files` item (fields we use). */
export type GitHubPullFile = {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  /** Absent for binary files and for patches GitHub considers too large. */
  patch?: string;
};

/** A changed file normalized from the GitHub API or the page fallback. */
export type ChangedFile = {
  path: string;
  /** GitHub status: added | removed | modified | renamed | copied | changed | unchanged */
  status: string;
  changes: number;
  patch: string | null;
};

export type FileCategory =
  'reviewable' | 'excluded_generated' | 'excluded_binary' | 'excluded_no_changes' | 'no_patch';

const GENERATED_FILE_RE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|composer\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|go\.sum|flake\.lock)$|\.min\.(js|css)$|(^|\/)(dist|build|vendor|node_modules|\.next|coverage|__generated__|generated)\/|\.snap$|\.map$|\.pb\.go$|_pb2\.py$|\.g\.dart$|\.generated\.\w+$/i;

const BINARY_EXT_RE =
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|so|dylib|dll|exe|bin|wasm|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|webm|ogg|wav|flac|sqlite|db|parquet|pkl|onnx|pt)$/i;

export function isGeneratedOrLockFile(path: string): boolean {
  return GENERATED_FILE_RE.test(path);
}

export function isBinaryPath(path: string): boolean {
  return BINARY_EXT_RE.test(path);
}

export function normalizeGitHubFiles(files: GitHubPullFile[]): ChangedFile[] {
  const seen = new Set<string>();
  const out: ChangedFile[] = [];
  for (const file of files) {
    const path = file.filename?.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({
      path,
      status: file.status ?? 'modified',
      changes:
        typeof file.changes === 'number'
          ? file.changes
          : (file.additions ?? 0) + (file.deletions ?? 0),
      patch: typeof file.patch === 'string' && file.patch.length > 0 ? file.patch : null,
    });
  }
  return out;
}

export function categorizeFile(file: ChangedFile): FileCategory {
  if (isGeneratedOrLockFile(file.path)) return 'excluded_generated';
  if (isBinaryPath(file.path)) return 'excluded_binary';
  if (!file.patch) {
    // Pure renames / mode changes have nothing to review; anything else lost its patch.
    if (file.changes === 0 && (file.status === 'renamed' || file.status === 'unchanged')) {
      return 'excluded_no_changes';
    }
    return 'no_patch';
  }
  return 'reviewable';
}

const SECURITY_RE =
  /(^|[/._-])(auth|oauth|sso|saml|jwt|session|login|password|passwd|secret|secrets|credential|token|crypto|encrypt|decrypt|permission|permissions|rbac|acl|policy|policies|guard|guards|middleware|security|csrf|cors|sanitize|webhook|webhooks|billing|payment|payments|paddle|stripe|invoice|admin|tenant|workspace)s?([/._-]|$)/i;
const INFRA_RE =
  /(^|\/)(\.github\/workflows\/|Dockerfile|docker-compose[^/]*\.ya?ml$|helm\/|k8s\/|terraform\/|.*\.tf$)|(^|\/)(migrations?|prisma)\/|\.sql$|schema\.prisma$/i;
const TEST_RE =
  /(^|\/)(__tests__|tests?|spec|e2e|__mocks__|fixtures?)\/|\.(spec|test)\.[cm]?[jt]sx?$|_test\.(go|py)$|\.e2e\./i;
/** Path looks like test code (a hint only: never enough on its own to reject a finding). */
export function looksLikeTestPath(path: string): boolean {
  return TEST_RE.test(path);
}
const DOC_RE =
  /\.(md|mdx|markdown|rst|txt|adoc)$|(^|\/)(docs?|documentation)\/|(^|\/)(LICENSE|CHANGELOG|AUTHORS)/i;
const SOURCE_RE =
  /\.([cm]?[jt]sx?|py|go|rb|java|kt|kts|scala|rs|cs|php|swift|m|mm|c|cc|cpp|h|hpp|ex|exs|erl|clj|dart|lua|vue|svelte|astro|sh|bash|zsh|ps1|sql|graphql|gql|proto)$/i;
const CONFIG_RE =
  /\.(json|ya?ml|toml|ini|cfg|conf|env\.example|properties|xml|gradle|lock)$|(^|\/)\.env/i;

/**
 * Review priority (higher first). Security-sensitive and infrastructure code first, then
 * application source, configuration, tests, and docs. Deleted files and generated files sort
 * lower. Never depends on GitHub's alphabetical order.
 */
export function filePriority(file: Pick<ChangedFile, 'path' | 'status'>): number {
  const path = file.path;
  let score: number;
  if (DOC_RE.test(path)) score = 10;
  else if (TEST_RE.test(path)) score = 30;
  else if (SOURCE_RE.test(path)) score = 60;
  else if (CONFIG_RE.test(path)) score = 40;
  else score = 35;

  if (!DOC_RE.test(path) && !TEST_RE.test(path)) {
    if (SECURITY_RE.test(path)) score += 30;
    if (INFRA_RE.test(path)) score += 25;
  }
  if (file.status === 'removed') score -= 15;
  if (isGeneratedOrLockFile(path)) score = 0;
  return score;
}

/** Stable review order: priority desc, larger change first, then path for determinism. */
export function compareByPriority(
  a: ChangedFile & { priority: number },
  b: ChangedFile & { priority: number },
): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (b.changes !== a.changes) return b.changes - a.changes;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
