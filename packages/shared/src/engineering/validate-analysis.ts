import type {
  AnalysisBinding,
  EngineeringAlignment,
  EngineeringAlignmentAnalysis,
  EngineeringAlignmentRisk,
  EngineeringConfidence,
  EngineeringContext,
  EngineeringContextConflict,
  EngineeringContextSource,
  EngineeringContractAlignment,
  EngineeringCoverageStatus,
  EngineeringEvidence,
  EngineeringImplementationObservation,
  EngineeringRequirementCoverage,
} from '@project-x/types';

import { validateEngineeringEvidence } from './evidence';

const ALIGNMENTS = new Set<EngineeringAlignment>([
  'strong',
  'partial',
  'weak',
  'conflicting',
  'uncertain',
]);

const COVERAGE = new Set<EngineeringCoverageStatus>([
  'covered',
  'partial',
  'not-evident',
  'conflicting',
  'uncertain',
]);

const CONFIDENCE = new Set<EngineeringConfidence>(['high', 'medium', 'low']);

const CONTEXT_SOURCES = new Set<EngineeringContextSource>([
  'jira',
  'github-pr',
  'github-review',
  'openapi',
  'ci',
]);

type Severity = 'high' | 'medium' | 'low';
const SEVERITIES = new Set<Severity>(['high', 'medium', 'low']);

export type ValidateAnalysisResult =
  { ok: true; analysis: EngineeringAlignmentAnalysis } | { ok: false; message: string };

/**
 * Parse/normalize AI JSON into EngineeringAlignmentAnalysis.
 * Drops invalid evidence. When context is heavily truncated, forces confidence notes.
 */
export function validateEngineeringAlignmentAnalysis(
  raw: unknown,
  ctx: EngineeringContext,
  binding: AnalysisBinding,
  analyzedAt = new Date().toISOString(),
): ValidateAnalysisResult {
  const obj = parseObject(raw);
  if (!obj) {
    return { ok: false, message: 'Analysis payload is not a JSON object.' };
  }

  const overview = asNonEmptyString(obj.overview);
  if (!overview) {
    return { ok: false, message: 'Analysis overview is required.' };
  }

  const alignment = asEnum(obj.alignment, ALIGNMENTS);
  if (!alignment) {
    return { ok: false, message: 'Analysis alignment is invalid.' };
  }

  const heavilyTruncated = isHeavilyTruncated(ctx);
  const forceLowConfidence = heavilyTruncated;

  const requirementCoverage = mapArray(obj.requirementCoverage, (item, index) =>
    normalizeRequirementCoverage(item, ctx, forceLowConfidence, index),
  ).filter((x): x is EngineeringRequirementCoverage => x != null);

  const implementationObservations = mapArray(obj.implementationObservations, (item) =>
    normalizeObservation(item, ctx, forceLowConfidence),
  ).filter((x): x is EngineeringImplementationObservation => x != null);

  const contractAlignment = mapArray(obj.contractAlignment, (item) =>
    normalizeContractAlignment(item, ctx, forceLowConfidence),
  ).filter((x): x is EngineeringContractAlignment => x != null);

  const crossContextConflicts = mapArray(obj.crossContextConflicts, (item, index) =>
    normalizeConflict(item, ctx, index),
  ).filter((x): x is EngineeringContextConflict => x != null);

  const risks = mapArray(obj.risks, (item) => normalizeRisk(item, ctx)).filter(
    (x): x is EngineeringAlignmentRisk => x != null,
  );

  const openQuestions = mapArray(obj.openQuestions, (q) =>
    typeof q === 'string' && q.trim() ? q.trim() : null,
  ).filter((x): x is string => x != null);

  const scopeRaw = isRecord(obj.scope) ? obj.scope : {};
  const limitations = mapArray(scopeRaw.limitations, (l) =>
    typeof l === 'string' && l.trim() ? l.trim() : null,
  ).filter((x): x is string => x != null);

  if (heavilyTruncated) {
    limitations.push(
      'Context was heavily truncated; treat coverage as incomplete and confidence as capped.',
    );
  }
  if (ctx.scope.partial) {
    for (const reason of ctx.scope.truncationReasons) {
      if (!limitations.includes(reason)) {
        limitations.push(reason);
      }
    }
  }

  return {
    ok: true,
    analysis: {
      overview,
      alignment: heavilyTruncated && alignment === 'strong' ? 'partial' : alignment,
      requirementCoverage,
      implementationObservations,
      contractAlignment,
      crossContextConflicts,
      risks,
      openQuestions,
      scope: {
        partial: Boolean(scopeRaw.partial) || ctx.scope.partial || heavilyTruncated,
        limitations,
      },
      analyzedAt,
      binding,
    },
  };
}

function isHeavilyTruncated(ctx: EngineeringContext): boolean {
  const reasons = ctx.scope.truncationReasons;
  const heavyMarkers = [
    'pr-files-capped',
    'pr-diff-truncated',
    'pr-diff-budget-exhausted',
    'jira-description-truncated',
    'api-context-truncated',
  ];
  const hits = reasons.filter((r) => heavyMarkers.some((m) => r.startsWith(m))).length;
  return hits >= 2 || reasons.length >= 3;
}

function normalizeRequirementCoverage(
  item: unknown,
  ctx: EngineeringContext,
  forceLowConfidence: boolean,
  index: number,
): EngineeringRequirementCoverage | null {
  if (!isRecord(item)) {
    return null;
  }
  const criterion = asNonEmptyString(item.criterion);
  if (!criterion) {
    return null;
  }
  const status = asEnum(item.status, COVERAGE);
  if (!status) {
    return null;
  }
  let confidence = asEnum(item.confidence, CONFIDENCE) ?? 'medium';
  if (forceLowConfidence && confidence === 'high') {
    confidence = 'medium';
  }
  const criterionId = asNonEmptyString(item.criterionId) ?? `coverage-${index + 1}`;

  return {
    criterionId,
    criterion,
    criterionSource:
      item.criterionSource === 'description' ||
      item.criterionSource === 'comment' ||
      item.criterionSource === 'inferred'
        ? item.criterionSource
        : undefined,
    status,
    evidence: normalizeEvidenceList(item.evidence, ctx),
    notes: asOptionalString(item.notes),
    confidence,
  };
}

function normalizeObservation(
  item: unknown,
  ctx: EngineeringContext,
  forceLowConfidence: boolean,
): EngineeringImplementationObservation | null {
  if (!isRecord(item)) {
    return null;
  }
  const observation = asNonEmptyString(item.observation);
  if (!observation) {
    return null;
  }
  let confidence = asEnum(item.confidence, CONFIDENCE);
  if (forceLowConfidence && confidence === 'high') {
    confidence = 'medium';
  }
  const kind =
    item.kind === 'beyond-scope' || item.kind === 'implementation' || item.kind === 'other'
      ? item.kind
      : undefined;
  return {
    observation,
    kind,
    evidence: normalizeEvidenceList(item.evidence, ctx),
    confidence: confidence ?? undefined,
  };
}

function normalizeContractAlignment(
  item: unknown,
  ctx: EngineeringContext,
  forceLowConfidence: boolean,
): EngineeringContractAlignment | null {
  if (!isRecord(item)) {
    return null;
  }
  const aspect = asNonEmptyString(item.aspect);
  if (!aspect) {
    return null;
  }
  const status = asEnum(item.status, COVERAGE);
  if (!status) {
    return null;
  }
  let confidence = asEnum(item.confidence, CONFIDENCE);
  if (forceLowConfidence && confidence === 'high') {
    confidence = 'medium';
  }
  return {
    aspect,
    status,
    evidence: normalizeEvidenceList(item.evidence, ctx),
    notes: asOptionalString(item.notes),
    confidence: confidence ?? undefined,
  };
}

function normalizeConflict(
  item: unknown,
  ctx: EngineeringContext,
  index: number,
): EngineeringContextConflict | null {
  if (!isRecord(item)) {
    return null;
  }
  const title = asNonEmptyString(item.title);
  const description = asNonEmptyString(item.description);
  const severity = asEnum(item.severity, SEVERITIES);
  if (!title || !description || !severity) {
    return null;
  }
  const sources = mapArray(item.sources, (s) =>
    typeof s === 'string' && CONTEXT_SOURCES.has(s as EngineeringContextSource)
      ? (s as EngineeringContextSource)
      : null,
  ).filter((x): x is EngineeringContextSource => x != null);

  if (sources.length === 0) {
    return null;
  }

  return {
    id: asNonEmptyString(item.id) ?? `conflict-${index + 1}`,
    severity,
    sources,
    title,
    description,
    evidence: normalizeEvidenceList(item.evidence, ctx),
    recommendation: asOptionalString(item.recommendation),
  };
}

function normalizeRisk(item: unknown, ctx: EngineeringContext): EngineeringAlignmentRisk | null {
  if (!isRecord(item)) {
    return null;
  }
  const title = asNonEmptyString(item.title);
  const severity = asEnum(item.severity, SEVERITIES);
  if (!title || !severity) {
    return null;
  }
  const kind =
    item.kind === 'fact' || item.kind === 'potential' || item.kind === 'recommendation'
      ? item.kind
      : undefined;
  return {
    severity,
    title,
    description: asOptionalString(item.description),
    evidence: normalizeEvidenceList(item.evidence, ctx),
    kind,
  };
}

function normalizeEvidenceList(value: unknown, ctx: EngineeringContext): EngineeringEvidence[] {
  return mapArray(value, (item) => {
    if (!isRecord(item)) {
      return null;
    }
    return validateEngineeringEvidence(item as unknown as EngineeringEvidence, ctx);
  }).filter((x): x is EngineeringEvidence => x != null);
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(raw) ? raw : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapArray<T>(value: unknown, map: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(map);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asEnum<T extends string>(value: unknown, allowed: Set<T>): T | null {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : null;
}
