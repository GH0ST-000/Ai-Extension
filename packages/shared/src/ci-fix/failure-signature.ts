import type { CICheckFailureEvidence, CIFailureAnalysis } from '@project-x/types';

import { normalizeRepositoryPath } from './normalize-path';

function normalizeMessage(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, '')
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.z+-]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Deterministic best-effort failure signature from stable CI evidence.
 * Avoids hashing full noisy logs (timestamps/progress).
 */
export function buildCIFailureSignature(input: {
  checkName: string;
  evidence?: CICheckFailureEvidence | null;
  analysis?: CIFailureAnalysis | null;
}): string {
  const parts: string[] = [`check:${input.checkName.trim().toLowerCase()}`];

  const annotations = input.evidence?.annotations ?? [];
  for (const annotation of annotations.slice(0, 5)) {
    const path = annotation.path ? normalizeRepositoryPath(annotation.path) : null;
    const msg = normalizeMessage(annotation.title || annotation.message);
    parts.push(`ann:${path ?? ''}:${annotation.startLine ?? ''}:${msg}`);
  }

  for (const item of (input.evidence?.evidence ?? []).slice(0, 5)) {
    if (item.source === 'annotation' || item.source === 'check_summary') {
      const path = item.path ? normalizeRepositoryPath(item.path) : '';
      parts.push(`ev:${item.source}:${path ?? ''}:${normalizeMessage(item.excerpt)}`);
    }
  }

  if (input.analysis?.likelyRootCause) {
    parts.push(`cause:${normalizeMessage(input.analysis.likelyRootCause)}`);
  }

  if (parts.length <= 1 && input.evidence?.summaryText) {
    parts.push(`sum:${normalizeMessage(input.evidence.summaryText)}`);
  }

  return parts.join('|').slice(0, 1_500);
}

export function compareFailureSignatures(
  previous: string | undefined,
  current: string | undefined,
): 'same' | 'different' | 'unknown' {
  if (!previous || !current) {
    return 'unknown';
  }
  if (previous === current) {
    return 'same';
  }
  // Compare check + first annotation segment when present
  const prevCore = previous.split('|').slice(0, 3).join('|');
  const currCore = current.split('|').slice(0, 3).join('|');
  if (prevCore === currCore) {
    return 'same';
  }
  // Same check name but different evidence
  const prevCheck = previous.split('|')[0];
  const currCheck = current.split('|')[0];
  if (prevCheck && prevCheck === currCheck) {
    return 'different';
  }
  return 'different';
}
