import { PAGE_CONTEXT_CLOSE, PAGE_CONTEXT_OPEN } from '../constants/ai.constants';
import { neutralizeProjectMemoryMarkers } from '../prompts/prompt.utils';

/**
 * A repository file path exactly as the batch prompt shows it (F-20): control characters and
 * line breaks collapsed to a space, and prompt delimiters / Project Memory markers made inert,
 * so a file NAME cannot close the untrusted block or start a new prompt line. Kept in its own
 * module so the prompt builder and the findings validator (which maps a cited path back to
 * the real one) use the same function.
 */
export function pathAsShownInPrompt(path: string): string {
  // eslint-disable-next-line no-control-regex
  const singleLine = path.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ');
  return neutralizeProjectMemoryMarkers(
    singleLine
      .replaceAll(PAGE_CONTEXT_CLOSE, '<<END_CTX (literal)>>')
      .replaceAll(PAGE_CONTEXT_OPEN, '<<CTX (literal)>>'),
  );
}
