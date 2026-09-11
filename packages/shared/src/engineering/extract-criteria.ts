import type { AcceptanceCriterion } from '@project-x/types';
import { ENGINEERING_MAX_ACCEPTANCE_CRITERIA } from '@project-x/types';

const BULLET_LINE = /^\s*(?:[-*•]|\d+[.)]|[a-z][.)]|\[[ xX]?\])\s+(.+?)\s*$/;

const SECTION_HEADER = /^\s*acceptance\s+criteria\s*:?\s*$/i;

/**
 * Deterministically extract acceptance criteria from Jira description plain text.
 * Prefers an "Acceptance Criteria:" section when present; otherwise uses
 * bullet/numbered lines from the whole description. IDs are ac-1..ac-N.
 */
export function extractAcceptanceCriteriaFromPlainText(
  plainText: string,
  max = ENGINEERING_MAX_ACCEPTANCE_CRITERIA,
): AcceptanceCriterion[] {
  if (!plainText.trim() || max <= 0) {
    return [];
  }

  const lines = plainText.replace(/\r\n/g, '\n').split('\n');
  const sectionLines = collectAcceptanceCriteriaSection(lines);
  const sourceLines = sectionLines ?? lines;

  const criteria: AcceptanceCriterion[] = [];
  const seen = new Set<string>();

  for (const line of sourceLines) {
    if (criteria.length >= max) {
      break;
    }
    const match = BULLET_LINE.exec(line);
    if (!match?.[1]) {
      continue;
    }
    const text = match[1].trim();
    if (!text || text.length < 3) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    criteria.push({
      id: `ac-${criteria.length + 1}`,
      text,
      source: 'description',
    });
  }

  return criteria;
}

function collectAcceptanceCriteriaSection(lines: string[]): string[] | null {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (SECTION_HEADER.test(lines[i] ?? '')) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) {
    return null;
  }

  const section: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // Stop at the next markdown-ish heading (non-bullet, short title-like line ending with :)
    if (section.length > 0 && /^\s*[A-Za-z].{0,60}:\s*$/.test(line) && !BULLET_LINE.test(line)) {
      break;
    }
    section.push(line);
  }
  return section;
}
