import type { AIAction, PromptSnapshotRecord, PromptVersionRef } from '@project-x/types';

import { RELIABILITY_PROMPT_REGISTRY_NAME } from './budgets';
import { sha256Hex } from './hash';
import { preparePromptSnapshotBody, redactForReliability } from './redaction';

export function hashPromptContent(content: string): string {
  return sha256Hex(redactForReliability(content));
}

export function hashBoundedInput(parts: ReadonlyArray<string>): string {
  const joined = parts.map((part) => redactForReliability(part)).join('\n---\n');
  return sha256Hex(joined);
}

/**
 * Prompt registry versioning: content hash drives version identity.
 * Callers supply a monotonic version integer when the hash changes.
 */
export function buildPromptVersionRef(input: {
  name?: string;
  version: number;
  hash: string;
  capability?: string;
  action?: AIAction | string;
  createdAt: string;
}): PromptVersionRef {
  return {
    name: input.name ?? RELIABILITY_PROMPT_REGISTRY_NAME,
    version: input.version,
    hash: input.hash,
    createdAt: input.createdAt,
    ...(input.capability ? { capability: input.capability } : {}),
    ...(input.action ? { action: String(input.action) } : {}),
  };
}

export function createPromptSnapshot(input: {
  id: string;
  name: string;
  version: number;
  capability?: string;
  action?: string;
  rawBody: string;
  createdAt: string;
}): PromptSnapshotRecord {
  const prepared = preparePromptSnapshotBody(input.rawBody);
  const hash = hashPromptContent(input.rawBody);
  return {
    id: input.id,
    name: input.name,
    version: input.version,
    hash,
    createdAt: input.createdAt,
    body: prepared.body,
    truncated: prepared.truncated,
    redacted: prepared.redacted,
    ...(input.capability ? { capability: input.capability } : {}),
    ...(input.action ? { action: input.action } : {}),
  };
}

export function resolveNextPromptVersion(
  existing: ReadonlyArray<{ hash: string; version: number }>,
  nextHash: string,
): { version: number; isNew: boolean } {
  const match = existing.find((row) => row.hash === nextHash);
  if (match) {
    return { version: match.version, isNew: false };
  }
  const maxVersion = existing.reduce((max, row) => Math.max(max, row.version), 0);
  return { version: maxVersion + 1, isNew: true };
}
