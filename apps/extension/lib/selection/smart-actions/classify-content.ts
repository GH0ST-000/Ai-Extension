import type { ContentType, PageContextType } from '@project-x/types';

export type GitHubViewKind = 'pr' | 'blob' | 'other';

export type RankingHints = {
  /** Normalized page adapter type when known. */
  pageType?: PageContextType;
  /** Selection appears inside a code-ish host element (pre/code). */
  selectionInCodeElement?: boolean;
  /** Host looks like a code host (e.g. GitHub blob/PR). */
  codeHost?: boolean;
  /** Finer GitHub surface for Day 7 ranking. */
  githubView?: GitHubViewKind;
};

const ERROR_PATTERNS: readonly RegExp[] = [
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)\b/,
  /\b(NullPointerException|IllegalArgumentException|RuntimeException|Exception)\b/,
  /\bUncaught\b/i,
  /\bCannot read propert(y|ies)\b/i,
  /\bis not (a function|defined)\b/i,
  /\bECONNREFUSED\b|\bENOTFOUND\b|\bETIMEDOUT\b/,
  /\bHTTP\/\d|status code [45]\d\d\b/i,
  /^\s*at\s+\S+/m,
  /\berror:\s+/i,
  /\bfailed to\b.+\bwith\b/i,
  /\btraceback\b \(most recent call last\)/i,
  /\bpanic:/i,
];

const CODE_KEYWORDS =
  /\b(function|const|let|var|class|interface|type|import|export|return|async|await|def|fn|pub|impl|struct|enum|package|namespace|using|public|private|protected|static|void|int|string|boolean|true|false|null|undefined|this|self|new|try|catch|throw|yield|match|select|from|where)\b/;

const STRUCTURED_PATTERNS: readonly RegExp[] = [
  /^\s*[[{][\s\S]*[\]}]\s*$/,
  /^\s*[\w."'-]+\s*:\s*.+$/m,
  /^[^,\n]+(?:,[^,\n]+){3,}$/m,
  /^\|.+\|/m,
  /^\s*[\w.-]+\s*=\s*.+$/m,
];

function countMatches(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  return (text.match(global) ?? []).length;
}

function wordCount(text: string): number {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return parts.length;
}

function looksLikeError(text: string): boolean {
  if (ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const stackish = lines.filter((line) => /^at\s+/.test(line) || /:\d+:\d+/.test(line)).length;
  return stackish >= 2 && lines.length >= 2;
}

function looksLikeCode(text: string, hints?: RankingHints): boolean {
  if (hints?.selectionInCodeElement) {
    return true;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const lines = trimmed.split('\n');
  const braceScore = countMatches(trimmed, /[{}[\]();]/g) / Math.max(trimmed.length, 1);
  const keywordHits = countMatches(trimmed, CODE_KEYWORDS);
  const indented = lines.filter((line) => /^\s{2,}|\t/.test(line)).length;
  const hasCodeFence = /^```[\w+-]*$/m.test(trimmed) || /```/.test(trimmed);
  const semicolonDensity = countMatches(trimmed, /;/g) / Math.max(lines.length, 1);
  const looksLikeDiff =
    /^[+-][^+-]/.test(trimmed) ||
    countMatches(trimmed, /^[+-]/gm) >= 2 ||
    /\bdiff --git\b/.test(trimmed);

  if (hasCodeFence || looksLikeDiff) {
    return true;
  }

  if (keywordHits >= 2 && (braceScore > 0.02 || semicolonDensity >= 0.35)) {
    return true;
  }

  if (lines.length >= 2 && indented >= Math.ceil(lines.length * 0.4) && keywordHits >= 1) {
    return true;
  }

  if (hints?.codeHost && (keywordHits >= 1 || braceScore > 0.015 || indented >= 1)) {
    return true;
  }

  if (
    lines.length === 1 &&
    keywordHits >= 1 &&
    /[(){};=<>]/.test(trimmed) &&
    wordCount(trimmed) <= 20
  ) {
    return true;
  }

  return false;
}

function looksLikeStructuredData(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) {
    return false;
  }

  if (STRUCTURED_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    if (
      /^\s*[\w."'-]+\s*:\s*.+$/m.test(trimmed) &&
      wordCount(trimmed) > 40 &&
      !/[[{]/.test(trimmed)
    ) {
      return false;
    }
    return true;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * Classify selected text with cheap heuristics. Optional hints (DOM/host)
 * refine code detection without network or AI calls.
 */
export function classifyContent(text: string, hints?: RankingHints): ContentType {
  const trimmed = text.trim();
  if (!trimmed) {
    return 'unknown';
  }

  if (looksLikeError(trimmed)) {
    return 'error';
  }

  if (looksLikeCode(trimmed, hints)) {
    return 'code';
  }

  if (looksLikeStructuredData(trimmed)) {
    return 'structured-data';
  }

  const words = wordCount(trimmed);
  const hasSentence = /[.!?]["')\]]*\s|$/.test(trimmed) && words >= 6;

  if (words <= 8 && trimmed.length <= 80 && !trimmed.includes('\n')) {
    return 'short-text';
  }

  if (hasSentence || words >= 12 || trimmed.includes('\n')) {
    return 'prose';
  }

  if (words <= 12) {
    return 'short-text';
  }

  return 'unknown';
}

export function detectGitHubView(pathname: string): GitHubViewKind {
  if (/\/pull\/\d+/i.test(pathname)) {
    return 'pr';
  }
  if (/\/(blob|tree)\//i.test(pathname)) {
    return 'blob';
  }
  return 'other';
}

/**
 * Lightweight page/selection signals for ranking — no AI, no network.
 */
export function sniffRankingHints(options?: { selectionRoot?: Node | null }): RankingHints {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return {};
  }

  let pageType: PageContextType | undefined;
  let codeHost = false;
  let githubView: GitHubViewKind | undefined;

  try {
    const host = window.location.hostname;
    const path = window.location.pathname;
    if (/(^|\.)github\.com$/i.test(host)) {
      pageType = 'github';
      githubView = detectGitHubView(path);
      codeHost =
        githubView === 'pr' ||
        githubView === 'blob' ||
        /\/(compare|commit)\b/.test(path) ||
        /\/.+\/.+/.test(path);
    }
  } catch {
    // ignore invalid location
  }

  let selectionInCodeElement = false;
  const root = options?.selectionRoot;
  if (root && root instanceof Element) {
    selectionInCodeElement = Boolean(
      root.closest('pre, code, [class*="highlight"], .blob-code, .js-file-line, td.blob-code'),
    );
  } else {
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    const element = node instanceof Element ? node : (node?.parentElement ?? null);
    if (element) {
      selectionInCodeElement = Boolean(
        element.closest('pre, code, [class*="highlight"], .blob-code, .js-file-line, td.blob-code'),
      );
    }
  }

  return {
    pageType,
    codeHost,
    githubView,
    selectionInCodeElement,
  };
}
