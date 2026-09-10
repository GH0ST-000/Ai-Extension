import type { ErrorCategory, ErrorClassification } from '@project-x/types';

import { ERROR_CONFIDENCE_THRESHOLD } from './error-intelligence.constants';
import { ERROR_SIGNAL_PATTERNS, HTTP_STATUS_CODES, TECHNICAL_HTTP_CONTEXT } from './error-patterns';
import { parseStackTrace } from './stack-trace.parser';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function pickCategory(scores: Map<ErrorCategory, number>): ErrorCategory | undefined {
  let best: ErrorCategory | undefined;
  let bestScore = 0;
  for (const [category, score] of scores) {
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Deterministic multi-signal error classification.
 * One weak word ("failed", "error") is never enough.
 */
export function classifyError(text: string): ErrorClassification {
  const trimmed = text.trim();
  if (!trimmed) {
    return { isError: false, confidence: 0, signals: [] };
  }

  const signals: string[] = [];
  let confidence = 0;
  const categoryScores = new Map<ErrorCategory, number>();
  let technology: string | undefined;
  let errorCode: string | undefined;

  const bumpCategory = (category: ErrorCategory | undefined, weight: number) => {
    if (!category) {
      return;
    }
    categoryScores.set(category, (categoryScores.get(category) ?? 0) + weight);
  };

  for (const rule of ERROR_SIGNAL_PATTERNS) {
    const match = trimmed.match(rule.pattern);
    if (!match) {
      continue;
    }

    // Soften bare *Exception / *Error suffix hits unless other tech evidence exists
    if (rule.id === 'java-exception') {
      const name = match[1] ?? '';
      const knownJs =
        /^(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|Error)$/.test(name);
      if (!knownJs && !/\bException\b/.test(name)) {
        continue;
      }
      if (name === 'Error' && !/^\s*Error:/m.test(trimmed) && !/\bError:\s/.test(trimmed)) {
        // Bare word "Error" in prose — skip
        continue;
      }
    }

    confidence += rule.weight;
    signals.push(rule.id);
    bumpCategory(rule.category, rule.weight);
    if (rule.technology && !technology) {
      technology = rule.technology;
    }
    if (rule.codeGroup != null && match[rule.codeGroup] && !errorCode) {
      errorCode = match[rule.codeGroup];
    } else if (rule.errorCode && !errorCode) {
      errorCode = rule.errorCode;
    }
  }

  // Conservative HTTP status codes — need technical neighbors
  const statusMatches = trimmed.match(/\b([45]\d{2})\b/g) ?? [];
  for (const code of statusMatches) {
    if (!HTTP_STATUS_CODES.has(code)) {
      continue;
    }
    if (!TECHNICAL_HTTP_CONTEXT.test(trimmed) && !/\bstatus\b/i.test(trimmed)) {
      continue;
    }
    // Avoid counting years / prose "404" alone without http/status wording already handled
    if (
      !TECHNICAL_HTTP_CONTEXT.test(trimmed) &&
      !/\b(error|failed|unauthorized|forbidden|not found)\b/i.test(trimmed)
    ) {
      continue;
    }
    confidence += 0.28;
    signals.push(`http-${code}`);
    bumpCategory('http', 0.28);
    if (!errorCode) {
      errorCode = code;
    }
    break;
  }

  const frames = parseStackTrace(trimmed);
  if (frames.length >= 2) {
    confidence += 0.22;
    signals.push('multi-stack-frames');
    bumpCategory('runtime', 0.22);
  } else if (frames.length === 1) {
    confidence += 0.12;
    signals.push('stack-frame');
    bumpCategory('runtime', 0.12);
  }

  // Weak standalone words — tiny bump only; never enough alone
  if (/\bfailed\b/i.test(trimmed) && signals.length === 0) {
    confidence += 0.08;
    signals.push('weak-failed');
  } else if (/\berror\b/i.test(trimmed) && signals.length === 0) {
    confidence += 0.1;
    signals.push('weak-error');
  }

  confidence = clamp01(confidence);
  const category =
    pickCategory(categoryScores) ??
    (confidence >= ERROR_CONFIDENCE_THRESHOLD ? 'unknown' : undefined);

  const isError =
    confidence >= ERROR_CONFIDENCE_THRESHOLD && signals.some((s) => !s.startsWith('weak-'));

  return {
    isError,
    confidence,
    category: isError ? category : undefined,
    technology: isError ? technology : undefined,
    errorCode: isError ? errorCode : undefined,
    signals,
  };
}
