import type { EngineeringContext, EngineeringEvidence } from '@project-x/types';
import { ENGINEERING_MAX_EVIDENCE_EXCERPT } from '@project-x/types';

import { normalizeRepositoryPath } from '../ci-fix/normalize-path';

const EVIDENCE_SOURCES = new Set(['jira', 'github-diff', 'github-finding', 'openapi', 'ci']);

/**
 * Validate AI-produced evidence against the grounded engineering context.
 * Rejects path traversal, unknown files, unknown criterion ids, and unknown operations.
 */
export function validateEngineeringEvidence(
  evidence: EngineeringEvidence,
  ctx: EngineeringContext,
): EngineeringEvidence | null {
  if (!evidence || typeof evidence !== 'object') {
    return null;
  }
  if (!EVIDENCE_SOURCES.has(evidence.source)) {
    return null;
  }
  if (typeof evidence.label !== 'string' || !evidence.label.trim()) {
    return null;
  }

  const ref = evidence.reference;
  let filePath: string | undefined;
  let criterionId: string | undefined;
  let issueKey: string | undefined;
  let operationId: string | undefined;
  let method: string | undefined;
  let path: string | undefined;
  let responseCode: string | undefined;
  let checkId: string | undefined;
  let findingId: string | undefined;
  let line: number | undefined;

  if (ref) {
    if (ref.filePath != null) {
      const normalized = normalizeRepositoryPath(ref.filePath);
      if (!normalized) {
        return null;
      }
      const knownFiles = new Set(ctx.github?.changedFiles.map((f) => f.path) ?? []);
      const knownFindingPaths = new Set(
        (ctx.github?.findings ?? []).map((f) => f.filePath).filter((p): p is string => Boolean(p)),
      );
      if (!knownFiles.has(normalized) && !knownFindingPaths.has(normalized)) {
        return null;
      }
      filePath = normalized;
    }

    if (ref.criterionId != null) {
      const ids = new Set([
        ...(ctx.jira?.explicitAcceptanceCriteria.map((c) => c.id) ?? []),
        ...(ctx.jira?.inferredAcceptanceCriteria?.map((c) => c.id) ?? []),
      ]);
      if (!ids.has(ref.criterionId)) {
        return null;
      }
      criterionId = ref.criterionId;
    }

    if (ref.issueKey != null) {
      if (ctx.jira && ref.issueKey.toUpperCase() !== ctx.jira.issueKey.toUpperCase()) {
        return null;
      }
      issueKey = ref.issueKey;
    }

    if (ref.operationId != null || ref.method != null || ref.path != null) {
      const op = ctx.api?.operation;
      if (!op) {
        return null;
      }
      if (ref.operationId != null) {
        if (!op.operationId || ref.operationId !== op.operationId) {
          return null;
        }
        operationId = ref.operationId;
      }
      if (ref.method != null) {
        if (ref.method.toUpperCase() !== op.method) {
          return null;
        }
        method = ref.method.toUpperCase();
      }
      if (ref.path != null) {
        if (ref.path !== op.path) {
          return null;
        }
        path = ref.path;
      }
    }

    if (ref.findingId != null) {
      const findingIds = new Set([
        ...(ctx.github?.findings?.map((f) => f.id) ?? []),
        ...(ctx.api?.contractFindings?.map((f) => f.id) ?? []),
      ]);
      if (!findingIds.has(ref.findingId)) {
        return null;
      }
      findingId = ref.findingId;
    }

    if (ref.checkId != null) {
      if (!ctx.ci) {
        return null;
      }
      checkId = ref.checkId;
    }

    responseCode = ref.responseCode;
    if (typeof ref.line === 'number' && ref.line > 0) {
      line = ref.line;
    }
  }

  let excerpt = evidence.excerpt;
  if (excerpt != null) {
    if (typeof excerpt !== 'string') {
      return null;
    }
    if (excerpt.length > ENGINEERING_MAX_EVIDENCE_EXCERPT) {
      excerpt = `${excerpt.slice(0, ENGINEERING_MAX_EVIDENCE_EXCERPT - 1)}…`;
    }
  }

  const hasReference =
    ref != null &&
    (filePath != null ||
      criterionId != null ||
      issueKey != null ||
      operationId != null ||
      method != null ||
      path != null ||
      responseCode != null ||
      checkId != null ||
      findingId != null ||
      line != null);

  return {
    source: evidence.source,
    label: evidence.label.trim(),
    reference: hasReference
      ? {
          issueKey,
          criterionId,
          filePath,
          line,
          operationId,
          method,
          path,
          responseCode,
          checkId,
          findingId,
        }
      : undefined,
    excerpt,
  };
}
