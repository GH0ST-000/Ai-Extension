import { forwardRef, type ReactNode, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';

import { cn } from '~/lib/utils/cn';

import type { AiActionDefinition } from '../types';
import { ActionMenuItem } from './action-menu-item';
import {
  ASSISTANT_TABS,
  actionsForTab,
  resolveDefaultAssistantTab,
  type AssistantTabId,
} from './assistant-tabs';

type ActionMenuProps = {
  actions: readonly AiActionDefinition[];
  onSelect: (action: AiActionDefinition) => void;
  pageType?: string | null;
  hasOpenApi?: boolean;
  hasJiraIssue?: boolean;
  hasGithub?: boolean;
  /** Extra chrome rendered inside the active tab (context panels). */
  textSlot?: ReactNode;
  githubSlot?: ReactNode;
  jiraSlot?: ReactNode;
  apiSlot?: ReactNode;
  workflowSlot?: ReactNode;
};

export const ActionMenu = forwardRef<HTMLDivElement, ActionMenuProps>(function ActionMenu(
  {
    actions,
    onSelect,
    pageType = null,
    hasOpenApi = false,
    hasJiraIssue = false,
    hasGithub = false,
    textSlot,
    githubSlot,
    jiraSlot,
    apiSlot,
    workflowSlot,
  },
  ref,
) {
  const defaultTab = useMemo(
    () =>
      resolveDefaultAssistantTab({
        pageType,
        hasOpenApi,
        hasJiraIssue,
        hasGithub,
      }),
    [pageType, hasOpenApi, hasJiraIssue, hasGithub],
  );

  const [tab, setTab] = useState<AssistantTabId>(defaultTab);

  useEffect(() => {
    setTab(defaultTab);
  }, [defaultTab]);

  const filtered = useMemo(() => {
    const allowed = actionsForTab(tab);
    return actions.filter((action) => allowed.has(action.id));
  }, [actions, tab]);

  const slot =
    tab === 'text'
      ? textSlot
      : tab === 'github'
        ? githubSlot
        : tab === 'jira'
          ? jiraSlot
          : tab === 'api'
            ? apiSlot
            : workflowSlot;

  const showCatalogActions = tab === 'text' || tab === 'github';
  const showEmptyHint =
    !slot && (tab === 'jira' || tab === 'api' || tab === 'workflow' || !showCatalogActions);

  return (
    <motion.div
      ref={ref}
      role="menu"
      aria-label="Project X actions"
      initial={{ opacity: 0, scale: 0.96, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 4 }}
      transition={{ type: 'spring', stiffness: 480, damping: 32, mass: 0.55 }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      className={cn(
        'pointer-events-auto w-[300px] overflow-hidden rounded-[14px]',
        'bg-elevated text-primary shadow-menu backdrop-blur-2xl',
        'border border-border',
      )}
    >
      <div className="border-b border-border px-2.5 pb-2 pt-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Project X
        </p>
        <div
          role="tablist"
          aria-label="Action categories"
          className="mt-2 grid grid-cols-5 gap-0.5 rounded-lg bg-icon p-0.5"
        >
          {ASSISTANT_TABS.map((item) => {
            const active = tab === item.id;
            const accent =
              (item.id === 'api' && hasOpenApi) ||
              (item.id === 'jira' && hasJiraIssue) ||
              (item.id === 'github' && hasGithub);
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className={cn(
                  'relative rounded-md px-0.5 py-1.5 text-[10px] font-semibold tracking-tight transition-colors',
                  active ? 'bg-elevated text-primary shadow-sm' : 'text-muted hover:text-secondary',
                )}
              >
                {item.label}
                {accent && !active ? (
                  <span
                    aria-hidden
                    className="absolute right-0.5 top-1 h-1 w-1 rounded-full bg-accent"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="max-h-[360px] overflow-y-auto">
        {slot ? <div className="border-b border-border">{slot}</div> : null}

        {showCatalogActions ? (
          <div className="flex flex-col p-1">
            {filtered.map((action, index) => (
              <ActionMenuItem key={action.id} action={action} index={index} onSelect={onSelect} />
            ))}
          </div>
        ) : null}

        {showEmptyHint ? (
          <div className="px-3 py-5 text-center">
            <p className="text-[12px] font-medium text-secondary">
              {tab === 'api'
                ? 'No API contract here'
                : tab === 'jira'
                  ? 'No Jira issue in context'
                  : tab === 'workflow'
                    ? 'No workflow yet'
                    : 'Nothing here yet'}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-muted">
              {tab === 'api'
                ? 'Open Swagger UI or an OpenAPI JSON/YAML document to analyze endpoints.'
                : tab === 'jira'
                  ? 'Open a Jira issue first. Project X keeps it for Compare with API when you switch to Swagger.'
                  : tab === 'workflow'
                    ? 'Describe a goal to generate a safe multi-step plan.'
                    : 'Select text to get started.'}
            </p>
          </div>
        ) : null}
      </div>
    </motion.div>
  );
});
