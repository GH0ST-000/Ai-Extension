import type { ErrorIntelligenceContext, PageContext } from '@project-x/types';

import {
  MAX_ERROR_CODE_CONTEXT_CHARACTERS,
  MAX_ERROR_TEXT_CHARACTERS,
  MAX_STACK_TRACE_CHARACTERS,
} from './error-intelligence.constants';
import { classifyError } from './error-classifier';
import { redactSensitiveText } from './sensitive-text-redactor';
import { extractStackTraceRaw, parseStackTrace } from './stack-trace.parser';

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}

export type BuildErrorIntelligenceInput = {
  text: string;
  context?: PageContext | null;
};

/**
 * Build a normalized ErrorIntelligenceContext for AI transmission.
 * Applies redaction + size limits. Safe to call when classification is weak
 * (returns null when not an error).
 */
export function buildErrorIntelligenceContext(
  input: BuildErrorIntelligenceInput,
): ErrorIntelligenceContext | null {
  const classification = classifyError(input.text);
  if (!classification.isError) {
    return null;
  }

  const { text: redactedText, redacted } = redactSensitiveText(input.text);
  const errorText = truncate(redactedText.trim(), MAX_ERROR_TEXT_CHARACTERS);
  const frames = parseStackTrace(errorText);
  const stackRaw = extractStackTraceRaw(errorText, MAX_STACK_TRACE_CHARACTERS);

  const pageContext = input.context;
  const surroundingCode = pageContext?.code?.surroundingCode
    ? truncate(
        redactSensitiveText(pageContext.code.surroundingCode).text,
        MAX_ERROR_CODE_CONTEXT_CHARACTERS,
      )
    : undefined;

  if (process.env.NODE_ENV === 'development') {
    // Safe metadata only — never log error body / stack / secrets.
    console.debug('[project-x:error-intelligence]', {
      category: classification.category,
      confidence: classification.confidence,
      technology: classification.technology,
      errorCode: classification.errorCode,
      selectedChars: errorText.length,
      stackFrameCount: frames.length,
      redactionOccurred: redacted,
    });
  }

  return {
    classification,
    errorText,
    stackTrace:
      frames.length > 0 || stackRaw
        ? {
            raw: stackRaw,
            frames: frames.length > 0 ? frames : undefined,
          }
        : undefined,
    page: pageContext
      ? {
          url: pageContext.url,
          title: pageContext.title,
        }
      : undefined,
    code:
      surroundingCode || pageContext?.code?.language || pageContext?.code?.fileName
        ? {
            language: pageContext?.code?.language,
            fileName: pageContext?.code?.fileName,
            surroundingCode,
          }
        : undefined,
    github: pageContext?.github
      ? {
          owner: pageContext.github.owner,
          repository: pageContext.github.repository,
          filePath: pageContext.github.filePath,
          pullRequestNumber: pageContext.github.pullRequestNumber,
          pullRequestTitle: pageContext.github.pullRequestTitle,
        }
      : undefined,
  };
}
