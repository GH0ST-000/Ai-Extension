import type {
  CIAffectedFile,
  CIAnalysisConfidence,
  CIFailureAnalysis,
  CIFailureEvidenceItem,
  CIRelatedToPullRequest,
} from '@project-x/types';

import { normalizeRepositoryPath } from '../patch-path';

type RawAnalysis = {
  summary?: unknown;
  likelyRootCause?: unknown;
  confidence?: unknown;
  relatedToPullRequest?: unknown;
  evidence?: unknown;
  affectedFiles?: unknown;
  suggestedNextSteps?: unknown;
  canSuggestFix?: unknown;
};

function asString(value: unknown, max = 4_000): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function parseConfidence(value: unknown): CIAnalysisConfidence {
  if (value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  return 'low';
}

function parseRelated(value: unknown): CIRelatedToPullRequest {
  if (value === 'likely' || value === 'unlikely' || value === 'uncertain') {
    return value;
  }
  return 'uncertain';
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as unknown;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim()) as unknown;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
  throw new Error('No JSON object found');
}

export function parseCIFailureAnalysisJson(
  rawText: string,
  meta: {
    owner: string;
    repository: string;
    pullRequestNumber: number;
    headSha: string;
    checkId: string;
    evidence: CIFailureEvidenceItem[];
    evidenceTruncated: boolean;
    trustedChangedPaths: string[];
  },
): CIFailureAnalysis {
  let parsed: RawAnalysis;
  try {
    parsed = extractJsonObject(rawText) as RawAnalysis;
  } catch {
    throw new Error('AI_ANALYSIS_FAILED');
  }

  const summary = asString(parsed.summary, 2_000);
  const likelyRootCause = asString(parsed.likelyRootCause, 4_000);
  if (!summary || !likelyRootCause) {
    throw new Error('AI_ANALYSIS_FAILED');
  }

  const trusted = new Set(meta.trustedChangedPaths);
  const affectedFiles: CIAffectedFile[] = [];
  if (Array.isArray(parsed.affectedFiles)) {
    for (const item of parsed.affectedFiles.slice(0, 20)) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const row = item as { path?: unknown; reason?: unknown; startLine?: unknown };
      const pathRaw = asString(row.path, 512);
      if (!pathRaw) {
        continue;
      }
      const normalized = normalizeRepositoryPath(pathRaw);
      if (!normalized) {
        continue;
      }
      const verified = trusted.has(normalized);
      affectedFiles.push({
        path: normalized,
        verified,
        reason: asString(row.reason, 500) ?? undefined,
        startLine: typeof row.startLine === 'number' ? row.startLine : undefined,
      });
    }
  }

  const suggestedNextSteps: string[] = [];
  if (Array.isArray(parsed.suggestedNextSteps)) {
    for (const step of parsed.suggestedNextSteps.slice(0, 8)) {
      const s = asString(step, 500);
      if (s) {
        suggestedNextSteps.push(s);
      }
    }
  }

  const verifiedAffected = affectedFiles.filter((f) => f.verified);
  const canSuggestFix =
    parsed.canSuggestFix === true && verifiedAffected.length > 0 && !meta.evidenceTruncated
      ? true
      : parsed.canSuggestFix === true && verifiedAffected.length > 0;

  // Prefer model flag but never allow Suggest Fix without a verified path.
  const safeCanSuggestFix = Boolean(canSuggestFix && verifiedAffected.length > 0);

  return {
    summary,
    likelyRootCause,
    confidence: meta.evidenceTruncated
      ? parseConfidence(parsed.confidence) === 'high'
        ? 'medium'
        : parseConfidence(parsed.confidence)
      : parseConfidence(parsed.confidence),
    relatedToPullRequest: parseRelated(parsed.relatedToPullRequest),
    evidence: meta.evidence,
    affectedFiles,
    suggestedNextSteps,
    canSuggestFix: safeCanSuggestFix,
    evidenceTruncated: meta.evidenceTruncated,
    owner: meta.owner,
    repository: meta.repository,
    pullRequestNumber: meta.pullRequestNumber,
    headSha: meta.headSha,
    checkId: meta.checkId,
    analyzedAt: new Date().toISOString(),
  };
}
