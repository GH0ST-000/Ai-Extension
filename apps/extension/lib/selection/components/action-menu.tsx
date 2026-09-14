import { forwardRef, type ReactNode, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';

import { cn } from '~/lib/utils/cn';

import type { AiActionDefinition } from '../types';
import { ActionMenuItem } from './action-menu-item';
import { BrandMark } from './brand-mark';
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
      initial={{ opacity: 0, scale: 0.94, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 6 }}
      transition={{ type: 'spring', stiffness: 420, damping: 30, mass: 0.6 }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      className={cn(
        'pointer-events-auto w-[320px] overflow-hidden rounded-panel',
        'px-panel-wash text-primary shadow-menu backdrop-blur-2xl',
        'border border-border',
      )}
    >
      <div className="relative border-b border-border px-3 pb-2.5 pt-3">
        <div className="flex items-center gap-2.5">
          <BrandMark className="shadow-float" />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold tracking-[-0.02em] text-primary">Project X</p>
            <p className="text-[11px] leading-tight text-muted">
              Pick an action for your selection
            </p>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Action categories"
          className="mt-3 grid grid-cols-5 gap-1 rounded-xl bg-bg/70 p-1 ring-1 ring-border"
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
                  'relative rounded-lg px-0.5 py-1.5 text-[10px] font-semibold tracking-tight transition-all duration-150',
                  active
                    ? 'bg-elevated text-primary shadow-sm ring-1 ring-border'
                    : 'text-muted hover:text-secondary',
                )}
              >
                {item.label}
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-2 -bottom-0.5 mx-auto h-0.5 rounded-full bg-accent"
                  />
                ) : null}
                {accent && !active ? (
                  <span
                    aria-hidden
                    className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="max-h-[380px] overflow-y-auto">
        {slot ? <div className="border-b border-border">{slot}</div> : null}

        {showCatalogActions ? (
          <div className="flex flex-col gap-0.5 p-1.5">
            {filtered.map((action, index) => (
              <ActionMenuItem key={action.id} action={action} index={index} onSelect={onSelect} />
            ))}
          </div>
        ) : null}

        {showEmptyHint ? (
          <div className="px-4 py-8 text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <span className="text-lg leading-none">·</span>
            </div>
            <p className="text-[13px] font-semibold tracking-tight text-primary">
              {tab === 'api'
                ? 'No API contract here'
                : tab === 'jira'
                  ? 'No Jira issue in context'
                  : tab === 'workflow'
                    ? 'No workflow yet'
                    : 'Nothing here yet'}
            </p>
            <p className="mt-1.5 text-[12px] leading-5 text-muted">
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
