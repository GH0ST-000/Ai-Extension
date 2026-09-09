export type PrRiskSeverity = 'high' | 'medium' | 'low' | 'unknown';

export type ParsedPrFinding = {
  index: number;
  severity: PrRiskSeverity;
  filePath: string | null;
  title: string;
  why: string;
  /** Full finding block for follow-up prompts. */
  raw: string;
};

export type ParsedPrReview = {
  summary: string;
  findings: ParsedPrFinding[];
  /** True when structured sections were detected. */
  structured: boolean;
};

const FINDING_RE = /^(\d+)\.\s*\*\*\[(high|medium|low)\]\*\*\s*(?:`([^`]+)`\s*[—–-]\s*)?(.+?)\s*$/i;

function normalizeSeverity(value: string): PrRiskSeverity {
  const lower = value.toLowerCase();
  if (lower === 'high' || lower === 'medium' || lower === 'low') {
    return lower;
  }
  return 'unknown';
}

/**
 * Parse REVIEW_ENTIRE_PR markdown into summary + numbered risk findings.
 */
export function parsePrReviewContent(content: string): ParsedPrReview {
  const trimmed = content.trim();
  if (!trimmed) {
    return { summary: '', findings: [], structured: false };
  }

  const summaryMatch = trimmed.match(/##\s*Summary\s*([\s\S]*?)(?=##\s*Risk Findings|$)/i);
  const findingsSectionMatch = trimmed.match(/##\s*Risk Findings\s*([\s\S]*)$/i);

  if (!summaryMatch && !findingsSectionMatch) {
    return { summary: trimmed, findings: [], structured: false };
  }

  const summary = (summaryMatch?.[1] ?? '').trim();
  const findingsBody = (findingsSectionMatch?.[1] ?? '').trim();
  const findings: ParsedPrFinding[] = [];

  if (findingsBody) {
    const blocks = findingsBody
      .split(/(?=^\d+\.\s)/m)
      .map((block) => block.trim())
      .filter(Boolean);

    for (const block of blocks) {
      const lines = block
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const header = lines[0] ?? '';
      const match = FINDING_RE.exec(header);
      if (!match) {
        continue;
      }

      const whyLine = lines.find((line) => /^why:/i.test(line));
      const why = whyLine
        ? whyLine.replace(/^why:\s*/i, '').trim()
        : lines.slice(1).join(' ').trim();

      findings.push({
        index: Number.parseInt(match[1] ?? '0', 10),
        severity: normalizeSeverity(match[2] ?? ''),
        filePath: match[3]?.trim() || null,
        title: (match[4] ?? '').trim(),
        why,
        raw: block,
      });
    }
  }

  return {
    summary,
    findings,
    structured: Boolean(summaryMatch || findings.length > 0),
  };
}
