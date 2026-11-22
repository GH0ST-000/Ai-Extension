import { redactSecretLines, redactSecretsForAi } from '@project-x/shared';

import type { PatchChunk } from './pr-review/diff-hunks';
import type { PrReviewPlan } from './pr-review/pr-review-plan';

/**
 * M6 — secret redaction at the AI transmission boundary. Everything that leaves for an AI
 * provider passes through here; nothing upstream (the GitHub diff, deterministic analysis,
 * patch application, Review History) is modified. See `redactSecretsForAi` for the rules.
 */

type TextPart = { type: 'text'; text: string };
type MessageLike = { role: string; content: unknown };

function sanitizeContent(content: unknown): unknown {
  if (typeof content === 'string') return redactSecretsForAi(content);
  if (Array.isArray(content)) {
    return content.map((part: unknown) =>
      part && typeof part === 'object' && (part as TextPart).type === 'text'
        ? { ...(part as TextPart), text: redactSecretsForAi((part as TextPart).text) }
        : part,
    );
  }
  return content;
}

/**
 * N-7: a file provider whose output is redacted BEFORE any rendering (line numbers, verifier
 * windows, caller/dependency sections). Line count is preserved, so line numbers and quote
 * checks stay aligned with what the model sees. Only for content that is sent to the model.
 */
export function redactFileProviderForAi<
  F extends (path: string, signal?: AbortSignal) => Promise<string | null>,
>(provider: F): F {
  return (async (path: string, signal?: AbortSignal) => {
    const text = await provider(path, signal);
    return text == null ? text : redactSecretsForAi(text);
  }) as F;
}

/** Error text that may echo request content, safe for logs (bounded, redacted). */
export function redactErrorMessageForLog(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  return redactSecretsForAi(message.slice(0, 1000));
}

/** New message list with every text part redacted (inputs are not mutated). */
export function sanitizeModelMessages<M extends MessageLike>(messages: readonly M[]): M[] {
  return messages.map(
    (message) => ({ ...message, content: sanitizeContent(message.content) }) as M,
  );
}

/** Provider request text (instructions + messages), redacted. Idempotent. */
export function sanitizeProviderPrompt<
  T extends { instructions?: string; messages: readonly MessageLike[] },
>(prompt: T): T {
  return {
    ...prompt,
    ...(typeof prompt.instructions === 'string'
      ? { instructions: redactSecretsForAi(prompt.instructions) }
      : {}),
    messages: sanitizeModelMessages(prompt.messages),
  };
}

/**
 * Redacted copy of a diff chunk for the AI path. `lines` and `text` stay consistent — every
 * body line of `text` is `kind + lines[i].text` — so evidence the model quotes from the
 * prompt still matches the lines used for validation. Line numbers, kinds and hunk headers
 * (only their trailing context is redacted) are unchanged.
 */
export function redactChunkForAi(chunk: PatchChunk): PatchChunk {
  const redactedTexts = redactSecretLines(chunk.lines.map((line) => line.text));
  const lines = chunk.lines.map((line, i) =>
    redactedTexts[i] === line.text ? line : { ...line, text: redactedTexts[i]! },
  );
  let next = 0;
  const text = chunk.text
    .split('\n')
    .map((rendered) => {
      const line = chunk.lines[next];
      if (line && rendered === `${line.kind}${line.text}`) {
        next += 1;
        return `${line.kind}${redactedTexts[next - 1]}`;
      }
      return redactSecretsForAi(rendered); // hunk header, or a cut oversized line
    })
    .join('\n');
  if (text === chunk.text && lines.every((line, i) => line === chunk.lines[i])) return chunk;
  return { ...chunk, text, lines };
}

/**
 * The plan's batches with redacted chunks — the only part sent to the model and validated
 * against its answers. `plan.files` (coverage accounting) and the source diff are untouched.
 */
/**
 * Adversarial-review N1: redact every file's COMPLETE patch, lines in order, BEFORE it is cut
 * into batch chunks — a private key that straddles a chunk boundary is then still tracked from
 * its BEGIN line. Line count, diff markers and hunk headers are preserved, so planning and
 * line numbers are unchanged. The per-chunk pass (redactPlanForAi) stays as a second layer.
 */
export function redactDiffFilesForAi<F extends { patch?: string | null }>(
  files: readonly F[],
): F[] {
  return files.map((file) =>
    typeof file.patch === 'string' && file.patch.length > 0
      ? { ...file, patch: redactSecretsForAi(file.patch) }
      : file,
  );
}

export function redactPlanForAi(plan: PrReviewPlan): PrReviewPlan {
  return {
    ...plan,
    batches: plan.batches.map((batch) => ({
      ...batch,
      units: batch.units.map((unit) => ({ ...unit, chunk: redactChunkForAi(unit.chunk) })),
    })),
  };
}
