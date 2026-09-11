import { create } from 'zustand';
import { buildOperationAiContext, findOperation } from '@project-x/shared';
import type { NormalizedApiContract, NormalizedApiOperation } from '@project-x/types';

import { OpenApiApiError, parseOpenApiContent, parseOpenApiUrl } from '../../services/openapi-api';

type OpenApiSessionState = {
  contract: NormalizedApiContract | null;
  /** Raw document text for example/risks endpoints (never credentials). */
  content: string | null;
  sourceUrl: string | null;
  selectedOperationId: string | null;
  analyzedDocumentHash: string | null;
  loading: boolean;
  error: string | null;
  abortController: AbortController | null;
  loadFromUrl: (url: string) => Promise<NormalizedApiContract | null>;
  loadFromPageContent: (
    content: string,
    sourceUrl?: string,
  ) => Promise<NormalizedApiContract | null>;
  selectOperation: (operationId: string | null) => void;
  markAnalyzed: (documentHash?: string) => void;
  isStale: () => boolean;
  getSelectedOperation: () => NormalizedApiOperation | null;
  clear: () => void;
};

export const useOpenApiSessionStore = create<OpenApiSessionState>((set, get) => ({
  contract: null,
  content: null,
  sourceUrl: null,
  selectedOperationId: null,
  analyzedDocumentHash: null,
  loading: false,
  error: null,
  abortController: null,

  loadFromUrl: async (url) => {
    get().abortController?.abort();
    const controller = new AbortController();
    set({ loading: true, error: null, abortController: controller });
    try {
      const contract = await parseOpenApiUrl(url, controller.signal);
      let content: string | null = null;
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          credentials: 'omit',
        });
        if (response.ok) {
          const text = await response.text();
          if (text.length > 0 && text.length <= 1_500_000) {
            content = text;
          }
        }
      } catch {
        // Browser fetch is best-effort; AI explain still works from contract.
      }
      set({
        contract,
        content,
        sourceUrl: contract.source.documentUrl ?? url,
        loading: false,
        abortController: null,
        analyzedDocumentHash: null,
        selectedOperationId:
          contract.operations.length === 1 ? (contract.operations[0]?.id ?? null) : null,
      });
      return contract;
    } catch (err) {
      if (controller.signal.aborted) {
        return null;
      }
      set({
        loading: false,
        error: err instanceof OpenApiApiError ? err.message : 'Unable to load OpenAPI document.',
        abortController: null,
        contract: null,
        content: null,
      });
      return null;
    }
  },

  loadFromPageContent: async (content, sourceUrl) => {
    get().abortController?.abort();
    const controller = new AbortController();
    set({ loading: true, error: null, abortController: controller });
    try {
      const contract = await parseOpenApiContent(content, sourceUrl, controller.signal);
      set({
        contract,
        content,
        sourceUrl: sourceUrl ?? contract.source.documentUrl ?? null,
        loading: false,
        abortController: null,
        analyzedDocumentHash: null,
        selectedOperationId:
          contract.operations.length === 1 ? (contract.operations[0]?.id ?? null) : null,
      });
      return contract;
    } catch (err) {
      if (controller.signal.aborted) {
        return null;
      }
      set({
        loading: false,
        error: err instanceof OpenApiApiError ? err.message : 'Unable to parse OpenAPI document.',
        abortController: null,
        contract: null,
        content: null,
      });
      return null;
    }
  },

  selectOperation: (operationId) => {
    set({ selectedOperationId: operationId });
  },

  markAnalyzed: (documentHash) => {
    set({
      analyzedDocumentHash: documentHash ?? get().contract?.documentHash ?? null,
    });
  },

  isStale: () => {
    const { contract, analyzedDocumentHash } = get();
    if (!contract || !analyzedDocumentHash) {
      return false;
    }
    return contract.documentHash !== analyzedDocumentHash;
  },

  getSelectedOperation: () => {
    const { contract, selectedOperationId } = get();
    if (!contract || !selectedOperationId) {
      return null;
    }
    return findOperation(contract, { id: selectedOperationId });
  },

  clear: () => {
    get().abortController?.abort();
    set({
      contract: null,
      content: null,
      sourceUrl: null,
      selectedOperationId: null,
      analyzedDocumentHash: null,
      error: null,
      loading: false,
      abortController: null,
    });
  },
}));

export function buildApiPromptText(
  contract: NormalizedApiContract,
  operation: NormalizedApiOperation,
): string {
  return buildOperationAiContext(contract, operation);
}

export function formatApiExamplePromptText(
  example: {
    method: string;
    path: string;
    curl: string;
    headers: Record<string, string>;
    body?: unknown;
    notes: string[];
  },
  contextText: string,
): string {
  const parts = [
    contextText,
    '',
    '---',
    'GENERATED EXAMPLE (untrusted template — do not execute):',
    `${example.method} ${example.path}`,
    example.curl,
    Object.keys(example.headers).length
      ? `Headers: ${JSON.stringify(example.headers, null, 2)}`
      : null,
    example.body !== undefined ? `Body:\n${JSON.stringify(example.body, null, 2)}` : null,
    example.notes.length ? `Notes:\n${example.notes.map((n) => `- ${n}`).join('\n')}` : null,
  ];
  return parts
    .filter((p): p is string => p != null)
    .join('\n')
    .slice(0, 18_000);
}

export function formatApiRisksPromptText(
  analysis: {
    overview: string;
    riskLevel: string;
    findings: Array<{
      severity: string;
      category: string;
      title: string;
      description: string;
      recommendation?: string;
    }>;
    openQuestions: string[];
  },
  contextText: string,
): string {
  const findings = analysis.findings
    .map(
      (f) =>
        `- [${f.severity}/${f.category}] ${f.title}: ${f.description}${
          f.recommendation ? ` → ${f.recommendation}` : ''
        }`,
    )
    .join('\n');
  const parts = [
    contextText,
    '',
    '---',
    'DETERMINISTIC CONTRACT FINDINGS:',
    `Risk level: ${analysis.riskLevel}`,
    analysis.overview,
    findings || '(no findings)',
    analysis.openQuestions.length
      ? `Open questions:\n${analysis.openQuestions.map((q) => `- ${q}`).join('\n')}`
      : null,
  ];
  return parts
    .filter((p): p is string => p != null)
    .join('\n')
    .slice(0, 18_000);
}

export function formatApiChangesPromptText(
  diff: {
    baseRef: string;
    headRef: string;
    baseHash: string;
    headHash: string;
    breakingChanges: Array<{ impact: string; kind: string; title: string; description: string }>;
    nonBreakingChanges: Array<{ impact: string; kind: string; title: string; description: string }>;
    uncertainChanges: Array<{ impact: string; kind: string; title: string; description: string }>;
  },
  meta: { path: string; owner: string; repository: string; pullRequestNumber?: number },
): string {
  const formatGroup = (
    label: string,
    items: Array<{ kind: string; title: string; description: string }>,
  ) => {
    if (!items.length) {
      return `${label}: (none)`;
    }
    return [
      `${label} (${items.length}):`,
      ...items.map((c) => `- [${c.kind}] ${c.title}: ${c.description}`),
    ].join('\n');
  };

  const parts = [
    'DETERMINISTIC OPENAPI CONTRACT DIFF (structural facts — do not override):',
    `Repository: ${meta.owner}/${meta.repository}`,
    meta.pullRequestNumber != null ? `PR #${meta.pullRequestNumber}` : null,
    `Spec path: ${meta.path}`,
    `baseSha: ${diff.baseRef}`,
    `headSha: ${diff.headRef}`,
    `baseHash: ${diff.baseHash}`,
    `headHash: ${diff.headHash}`,
    '',
    formatGroup('Breaking', diff.breakingChanges),
    formatGroup('Non-breaking', diff.nonBreakingChanges),
    formatGroup('Uncertain', diff.uncertainChanges),
  ];
  return parts
    .filter((p): p is string => p != null)
    .join('\n')
    .slice(0, 18_000);
}
