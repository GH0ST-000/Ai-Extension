import { useCallback, useEffect, useMemo, useState } from 'react';
import { AIAction, type HttpMethod, type PageContextOpenApi } from '@project-x/types';

import { cn } from '~/lib/utils/cn';

import { extractOpenApiDocumentText } from '../../context/adapters/openapi.adapter';
import {
  fetchOpenApiRisks,
  generateOpenApiExample,
  OpenApiApiError,
} from '../../services/openapi-api';
import { ACTION_ICONS } from '../components/action-icons';
import { buildJiraIssuePromptText, useJiraSessionStore } from '../jira/jira.store';
import { useSelectionToolbarStore } from '../store';
import {
  buildApiPromptText,
  formatApiExamplePromptText,
  formatApiRisksPromptText,
  useOpenApiSessionStore,
} from './openapi.store';

type PanelAction = {
  id: AIAction;
  label: string;
  description: string;
  needsOperation: boolean;
  needsContent: boolean;
  kind: 'explain' | 'example' | 'risks';
};

const PANEL_ACTIONS: PanelAction[] = [
  {
    id: AIAction.EXPLAIN_API_ENDPOINT,
    label: 'Explain Endpoint',
    description: 'Purpose, auth, inputs, responses',
    needsOperation: true,
    needsContent: false,
    kind: 'explain',
  },
  {
    id: AIAction.EXPLAIN_API_REQUEST,
    label: 'Request',
    description: 'Params, body, required vs optional',
    needsOperation: true,
    needsContent: false,
    kind: 'explain',
  },
  {
    id: AIAction.EXPLAIN_API_RESPONSE,
    label: 'Response',
    description: 'Documented status codes only',
    needsOperation: true,
    needsContent: false,
    kind: 'explain',
  },
  {
    id: AIAction.GENERATE_API_EXAMPLE,
    label: 'Example',
    description: 'Synthetic request — never executed',
    needsOperation: true,
    needsContent: true,
    kind: 'example',
  },
  {
    id: AIAction.ANALYZE_API_CONTRACT,
    label: 'Contract Risks',
    description: 'Grounded design findings',
    needsOperation: false,
    needsContent: true,
    kind: 'risks',
  },
];

const METHOD_TONE: Record<HttpMethod, string> = {
  GET: 'bg-icon text-secondary',
  POST: 'bg-accent-soft text-accent',
  PUT: 'bg-accent-soft text-accent',
  PATCH: 'bg-accent-soft text-accent',
  DELETE: 'bg-[rgba(225,29,72,0.12)] text-[#e11d48]',
  HEAD: 'bg-icon text-muted',
  OPTIONS: 'bg-icon text-muted',
  TRACE: 'bg-icon text-muted',
};

export function OpenApiPanel(props: {
  pageOpenApi: PageContextOpenApi;
  onCompareWithJira?: () => void;
}) {
  const contract = useOpenApiSessionStore((s) => s.contract);
  const content = useOpenApiSessionStore((s) => s.content);
  const selectedOperationId = useOpenApiSessionStore((s) => s.selectedOperationId);
  const loading = useOpenApiSessionStore((s) => s.loading);
  const error = useOpenApiSessionStore((s) => s.error);
  const loadFromUrl = useOpenApiSessionStore((s) => s.loadFromUrl);
  const loadFromPageContent = useOpenApiSessionStore((s) => s.loadFromPageContent);
  const selectOperation = useOpenApiSessionStore((s) => s.selectOperation);
  const markAnalyzed = useOpenApiSessionStore((s) => s.markAnalyzed);
  const isStale = useOpenApiSessionStore((s) => s.isStale);
  const startAction = useSelectionToolbarStore((s) => s.startAction);
  const jiraIssue = useJiraSessionStore((s) => s.issue);

  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [endpointQuery, setEndpointQuery] = useState('');

  const documentKey = props.pageOpenApi.documentUrl ?? props.pageOpenApi.origin ?? '';

  useEffect(() => {
    const docUrl = props.pageOpenApi.documentUrl;
    if (docUrl) {
      void loadFromUrl(docUrl);
      return;
    }
    if (props.pageOpenApi.pageType === 'openapi-document') {
      const text = extractOpenApiDocumentText();
      if (text) {
        void loadFromPageContent(
          text,
          typeof window !== 'undefined' ? window.location.href : undefined,
        );
      }
    }
  }, [
    documentKey,
    props.pageOpenApi.documentUrl,
    props.pageOpenApi.pageType,
    loadFromUrl,
    loadFromPageContent,
  ]);

  useEffect(() => {
    const selected = props.pageOpenApi.selectedOperation;
    const current = useOpenApiSessionStore.getState();
    if (!selected || !current.contract || current.selectedOperationId) {
      return;
    }
    const match = current.contract.operations.find(
      (op) => op.method === selected.method && op.path === selected.path,
    );
    if (match) {
      selectOperation(match.id);
    }
  }, [props.pageOpenApi.selectedOperation, contract, selectOperation]);

  const selectedOperation = useMemo(() => {
    if (!contract || !selectedOperationId) {
      return null;
    }
    return contract.operations.find((op) => op.id === selectedOperationId) ?? null;
  }, [contract, selectedOperationId]);

  const filteredOperations = useMemo(() => {
    const ops = contract?.operations ?? [];
    const q = endpointQuery.trim().toLowerCase();
    if (!q) {
      return ops;
    }
    return ops.filter((op) => {
      const hay =
        `${op.method} ${op.path} ${op.summary ?? ''} ${op.operationId ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [contract?.operations, endpointQuery]);

  const runExplain = useCallback(
    (action: AIAction) => {
      const state = useOpenApiSessionStore.getState();
      const op = state.getSelectedOperation();
      if (!state.contract || !op) {
        return;
      }
      const text = buildApiPromptText(state.contract, op);
      useSelectionToolbarStore.setState({ selectedText: text });
      markAnalyzed(state.contract.documentHash);
      void startAction(action);
    },
    [markAnalyzed, startAction],
  );

  const runGenerateExample = useCallback(async () => {
    const state = useOpenApiSessionStore.getState();
    const op = state.getSelectedOperation();
    if (!state.contract || !op || !state.content) {
      setActionError(
        state.content
          ? 'Select an operation first.'
          : 'Document content unavailable for example generation.',
      );
      return;
    }
    setActionBusy(true);
    setActionError(null);
    try {
      const example = await generateOpenApiExample({
        content: state.content,
        sourceUrl: state.sourceUrl ?? undefined,
        operation: {
          id: op.id,
          method: op.method,
          path: op.path,
          operationId: op.operationId,
        },
      });
      const contextText = buildApiPromptText(state.contract, op);
      const text = formatApiExamplePromptText(example, contextText);
      useSelectionToolbarStore.setState({ selectedText: text });
      markAnalyzed(state.contract.documentHash);
      void startAction(AIAction.GENERATE_API_EXAMPLE);
    } catch (err) {
      setActionError(
        err instanceof OpenApiApiError ? err.message : 'Unable to generate API example.',
      );
    } finally {
      setActionBusy(false);
    }
  }, [markAnalyzed, startAction]);

  const runContractRisks = useCallback(async () => {
    const state = useOpenApiSessionStore.getState();
    const op = state.getSelectedOperation();
    if (!state.contract || !state.content) {
      setActionError('Document content unavailable for risk analysis.');
      return;
    }
    setActionBusy(true);
    setActionError(null);
    try {
      const analysis = await fetchOpenApiRisks({
        content: state.content,
        sourceUrl: state.sourceUrl ?? undefined,
        scope: op ? 'operation' : 'contract',
        operation: op
          ? { id: op.id, method: op.method, path: op.path, operationId: op.operationId }
          : undefined,
      });
      const contextText = op
        ? buildApiPromptText(state.contract, op)
        : `API: ${state.contract.title ?? 'Untitled'} (OpenAPI ${state.contract.version})\ndocumentHash: ${state.contract.documentHash}`;
      const text = formatApiRisksPromptText(analysis, contextText);
      useSelectionToolbarStore.setState({ selectedText: text });
      markAnalyzed(state.contract.documentHash);
      void startAction(AIAction.ANALYZE_API_CONTRACT);
    } catch (err) {
      setActionError(
        err instanceof OpenApiApiError ? err.message : 'Unable to analyze contract risks.',
      );
    } finally {
      setActionBusy(false);
    }
  }, [markAnalyzed, startAction]);

  const runPanelAction = useCallback(
    (action: PanelAction) => {
      if (action.kind === 'explain') {
        runExplain(action.id);
        return;
      }
      if (action.kind === 'example') {
        void runGenerateExample();
        return;
      }
      void runContractRisks();
    },
    [runContractRisks, runExplain, runGenerateExample],
  );

  const pageTypeLabel =
    props.pageOpenApi.pageType === 'swagger-ui'
      ? 'Swagger UI'
      : props.pageOpenApi.pageType === 'redoc'
        ? 'Redoc'
        : props.pageOpenApi.pageType === 'openapi-document'
          ? 'OpenAPI'
          : 'API docs';

  return (
    <div className="px-1 pb-1 pt-2">
      <div className="px-2">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-[12px] font-semibold text-primary">
            {contract?.title ?? 'API contract'}
          </p>
          <span className="shrink-0 text-[10px] text-muted">{pageTypeLabel}</span>
        </div>
        {contract?.partial ? (
          <p className="mt-0.5 text-[10px] text-muted">
            {contract.operationCountIncluded ?? contract.operations.length}
            {contract.operationCountTotal != null ? ` / ${contract.operationCountTotal}` : ''}{' '}
            operations
          </p>
        ) : null}
      </div>

      {loading ? (
        <p className="px-2 py-2 text-[11px] text-accent" role="status">
          Loading contract…
        </p>
      ) : null}
      {error ? (
        <p className="px-2 py-2 text-[11px] text-[#e11d48]" role="alert">
          {error}
        </p>
      ) : null}
      {actionError ? (
        <p className="px-2 py-2 text-[11px] text-[#e11d48]" role="alert">
          {actionError}
        </p>
      ) : null}
      {isStale() ? (
        <p className="px-2 py-1 text-[11px] text-secondary" role="status">
          Contract changed since this analysis.
        </p>
      ) : null}

      {contract && contract.operations.length > 0 ? (
        <div className="mt-2 px-1">
          <div className="px-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
              Endpoint
            </p>
            {(contract.operations.length > 6 || endpointQuery) && (
              <input
                type="search"
                value={endpointQuery}
                onChange={(event) => setEndpointQuery(event.target.value)}
                placeholder="Filter paths…"
                className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] text-primary outline-none placeholder:text-muted focus-visible:ring-1 focus-visible:ring-accent/40"
              />
            )}
          </div>

          <div className="mt-1 max-h-[132px] space-y-0.5 overflow-y-auto rounded-lg bg-icon/60 p-0.5">
            {filteredOperations.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-muted">No matching endpoints.</p>
            ) : (
              filteredOperations.map((op) => {
                const active = op.id === selectedOperationId;
                return (
                  <button
                    key={op.id}
                    type="button"
                    onClick={() => selectOperation(op.id)}
                    className={cn(
                      'flex w-full items-start gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors',
                      active ? 'bg-elevated shadow-sm ring-1 ring-border' : 'hover:bg-hover',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 shrink-0 rounded px-1 py-0.5 font-mono text-[9px] font-bold tracking-wide',
                        METHOD_TONE[op.method],
                      )}
                    >
                      {op.method}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11px] font-medium text-primary">
                        {op.path}
                      </span>
                      {op.summary ? (
                        <span className="mt-px block truncate text-[10px] text-muted">
                          {op.summary}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}

      {selectedOperation ? (
        <div className="mt-2 border-t border-border px-2 pt-2">
          <div className="flex items-start gap-1.5">
            <span
              className={cn(
                'mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold',
                METHOD_TONE[selectedOperation.method],
              )}
            >
              {selectedOperation.method}
            </span>
            <div className="min-w-0">
              <p className="break-all font-mono text-[11px] font-semibold leading-4 text-primary">
                {selectedOperation.path}
              </p>
              {selectedOperation.summary ? (
                <p className="mt-0.5 line-clamp-2 text-[11px] text-secondary">
                  {selectedOperation.summary}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : contract && !loading ? (
        <p className="mt-2 px-2 text-[11px] text-muted">Pick an endpoint to unlock actions.</p>
      ) : null}

      <div className="mt-1 flex flex-col">
        {PANEL_ACTIONS.map((action) => {
          const Icon = ACTION_ICONS[action.id];
          const disabled =
            loading ||
            actionBusy ||
            (action.needsOperation && !selectedOperation) ||
            (action.needsContent && !content) ||
            (action.kind === 'risks' && !contract);

          return (
            <button
              key={action.id}
              type="button"
              disabled={disabled}
              onClick={() => runPanelAction(action)}
              className={cn(
                'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                'text-primary transition-colors duration-100',
                'hover:bg-hover focus-visible:bg-active',
                'outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
                'disabled:pointer-events-none disabled:opacity-35',
              )}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-icon text-secondary transition-colors group-hover:text-accent">
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-medium leading-4 tracking-tight">
                  {action.label}
                </span>
                <span className="mt-px block truncate text-[11px] leading-tight text-muted">
                  {action.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {jiraIssue || props.onCompareWithJira ? (
        <div className="border-t border-border px-1 pt-1">
          <button
            type="button"
            disabled={!selectedOperation || !jiraIssue}
            onClick={props.onCompareWithJira}
            className={cn(
              'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left',
              'text-[12px] font-medium text-accent transition-colors',
              'hover:bg-hover disabled:opacity-40',
            )}
          >
            <span>Compare with Jira</span>
            {jiraIssue ? (
              <span className="font-mono text-[10px] text-muted">{jiraIssue.key}</span>
            ) : null}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Build combined prompt for COMPARE_API_WITH_JIRA. */
export function buildCompareApiWithJiraText(): string | null {
  const api = useOpenApiSessionStore.getState();
  const op = api.getSelectedOperation();
  const issue = useJiraSessionStore.getState().issue;
  if (!api.contract || !op || !issue) {
    return null;
  }
  return [
    buildJiraIssuePromptText(issue),
    '---',
    'API OPERATION CONTEXT (untrusted):',
    buildApiPromptText(api.contract, op),
  ]
    .join('\n\n')
    .slice(0, 18_000);
}
