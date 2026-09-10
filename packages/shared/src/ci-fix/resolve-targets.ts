import type {
  CICheckAnnotation,
  CICheckFailureEvidence,
  CIFailureAnalysis,
  CIFixTarget,
} from '@project-x/types';

import { normalizeRepositoryPath } from './normalize-path';

export type ResolveCIFixTargetsInput = {
  analysis?: CIFailureAnalysis | null;
  evidence?: CICheckFailureEvidence | null;
  changedFilePaths?: string[];
};

const SOURCE_RANK: Record<CIFixTarget['source'], number> = {
  annotation: 0,
  log: 1,
  'changed-file-correlation': 2,
  'ai-suggestion': 3,
};

const TRUST_RANK: Record<CIFixTarget['trust'], number> = {
  trusted: 0,
  correlated: 1,
  suggested: 2,
};

function pushUnique(targets: CIFixTarget[], next: CIFixTarget): void {
  const existing = targets.find((t) => t.filePath === next.filePath);
  if (!existing) {
    targets.push(next);
    return;
  }
  // Prefer stronger trust / earlier source / earlier line
  const better =
    TRUST_RANK[next.trust] < TRUST_RANK[existing.trust] ||
    (TRUST_RANK[next.trust] === TRUST_RANK[existing.trust] &&
      SOURCE_RANK[next.source] < SOURCE_RANK[existing.source]);
  if (better) {
    Object.assign(existing, next);
  } else if (existing.startLine == null && next.startLine != null) {
    existing.startLine = next.startLine;
    existing.endLine = next.endLine;
  }
}

function targetFromAnnotation(
  annotation: CICheckAnnotation,
  changedSet: Set<string>,
): CIFixTarget | null {
  if (!annotation.path) {
    return null;
  }
  const filePath = normalizeRepositoryPath(annotation.path);
  if (!filePath) {
    return null;
  }
  const inPr = changedSet.has(filePath);
  return {
    filePath,
    startLine: annotation.startLine,
    endLine: annotation.endLine,
    source: 'annotation',
    trust: 'trusted',
    verified: true,
    inPullRequestDiff: inPr,
    reason: annotation.title || annotation.message.slice(0, 120),
  };
}

/** Extract path-like tokens from log/evidence excerpts (deterministic, best-effort). */
export function extractPathsFromText(text: string): Array<{ path: string; startLine?: number }> {
  const results: Array<{ path: string; startLine?: number }> = [];
  const seen = new Set<string>();
  const pattern =
    /(?:^|[\s("'`]|(?:at\s+))((?:src|apps|packages|lib|test|tests|spec)\/[\w./+-]+\.\w+)(?::(\d+))?/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const path = normalizeRepositoryPath(match[1] ?? '');
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    const line = match[2] ? Number.parseInt(match[2], 10) : undefined;
    results.push({
      path,
      startLine: Number.isFinite(line) ? line : undefined,
    });
  }
  return results;
}

/**
 * Deterministic candidate fix targets from Day 15 evidence + analysis.
 * AI-suggested paths stay `suggested` until path-validated; never trusted solely from the model.
 */
export function resolveCIFixTargets(input: ResolveCIFixTargetsInput): CIFixTarget[] {
  const changedSet = new Set(
    (input.changedFilePaths ?? [])
      .map((p) => normalizeRepositoryPath(p))
      .filter((p): p is string => Boolean(p)),
  );
  const targets: CIFixTarget[] = [];

  for (const annotation of input.evidence?.annotations ?? []) {
    const t = targetFromAnnotation(annotation, changedSet);
    if (t) {
      pushUnique(targets, t);
    }
  }

  for (const item of input.evidence?.evidence ?? []) {
    if (item.path) {
      const filePath = normalizeRepositoryPath(item.path);
      if (filePath) {
        pushUnique(targets, {
          filePath,
          startLine: item.startLine,
          endLine: item.endLine,
          source: item.source === 'annotation' ? 'annotation' : 'log',
          trust: item.source === 'annotation' ? 'trusted' : 'correlated',
          verified: true,
          inPullRequestDiff: changedSet.has(filePath),
          reason: item.label,
        });
      }
    }
    for (const extracted of extractPathsFromText(item.excerpt)) {
      pushUnique(targets, {
        filePath: extracted.path,
        startLine: extracted.startLine,
        source: 'log',
        trust: 'correlated',
        verified: true,
        inPullRequestDiff: changedSet.has(extracted.path),
        reason: 'Referenced in failure evidence',
      });
    }
  }

  if (input.evidence?.logExcerpt) {
    for (const extracted of extractPathsFromText(input.evidence.logExcerpt)) {
      pushUnique(targets, {
        filePath: extracted.path,
        startLine: extracted.startLine,
        source: 'log',
        trust: 'correlated',
        verified: true,
        inPullRequestDiff: changedSet.has(extracted.path),
        reason: 'Referenced in log excerpt',
      });
    }
  }

  for (const file of input.analysis?.affectedFiles ?? []) {
    const filePath = normalizeRepositoryPath(file.path);
    if (!filePath) {
      continue;
    }
    pushUnique(targets, {
      filePath,
      startLine: file.startLine,
      source: 'ai-suggestion',
      trust: file.verified || changedSet.has(filePath) ? 'correlated' : 'suggested',
      verified: Boolean(normalizeRepositoryPath(file.path)),
      inPullRequestDiff: changedSet.has(filePath),
      reason: file.reason ?? 'Suggested by CI analysis',
    });
  }

  for (const path of changedSet) {
    // Only add changed files if already implicated — avoid listing entire PR.
    const implicated = targets.some((t) => t.filePath === path);
    if (!implicated) {
      continue;
    }
    const existing = targets.find((t) => t.filePath === path);
    if (existing) {
      existing.inPullRequestDiff = true;
    }
  }

  targets.sort((a, b) => {
    const trust = TRUST_RANK[a.trust] - TRUST_RANK[b.trust];
    if (trust !== 0) {
      return trust;
    }
    const source = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    if (source !== 0) {
      return source;
    }
    if (a.inPullRequestDiff && !b.inPullRequestDiff) {
      return -1;
    }
    if (!a.inPullRequestDiff && b.inPullRequestDiff) {
      return 1;
    }
    return a.filePath.localeCompare(b.filePath);
  });

  return targets;
}

/**
 * Auto-select when exactly one strong target exists; otherwise require user choice.
 */
export function selectPrimaryCIFixTarget(targets: CIFixTarget[]): {
  selected?: CIFixTarget;
  ambiguous: boolean;
  insufficient: boolean;
} {
  const usable = targets.filter((t) => t.verified && t.trust !== 'suggested');
  if (usable.length === 0) {
    const suggestedOnly = targets.filter((t) => t.verified);
    if (suggestedOnly.length === 1) {
      return { selected: suggestedOnly[0], ambiguous: false, insufficient: false };
    }
    return { insufficient: true, ambiguous: false };
  }
  if (usable.length === 1) {
    return { selected: usable[0], ambiguous: false, insufficient: false };
  }
  // Multiple trusted/correlated — ambiguous unless one annotation clearly wins
  const trusted = usable.filter((t) => t.trust === 'trusted');
  if (trusted.length === 1) {
    return { selected: trusted[0], ambiguous: false, insufficient: false };
  }
  return { ambiguous: true, insufficient: false };
}
