'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  ProjectMemoryAuditActorType,
  ProjectMemoryAuditEvent,
  ProjectMemoryAuditEventType,
  ProjectMemoryAuditRuleSummary,
} from '@project-x/types';
import { PROJECT_MEMORY_AUDIT_EVENT_TYPES } from '@project-x/types';
import { safeErrorMessage } from '@project-x/shared';

import { Dialog } from '../../../components/dialog';
import { StudioSelect, type StudioSelectOption } from '../../../components/studio-select';
import {
  AUDIT_EVENT_LABELS,
  auditActorLabel,
  auditReasonLabel,
  fetchMemoryAudit,
  fetchMemoryAuditRules,
  ruleEventCountLabel,
} from './memory-audit-data';

const RULES_PAGE_SIZE = 20;
const HISTORY_PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

const EVENT_OPTIONS: readonly StudioSelectOption<'all' | ProjectMemoryAuditEventType>[] = [
  { value: 'all', label: 'All events' },
  ...PROJECT_MEMORY_AUDIT_EVENT_TYPES.map((type) => ({
    value: type,
    label: AUDIT_EVENT_LABELS[type],
  })),
];

const ACTOR_OPTIONS: readonly StudioSelectOption<'all' | ProjectMemoryAuditActorType>[] = [
  { value: 'all', label: 'People and automatic' },
  { value: 'user', label: 'People' },
  { value: 'system', label: 'Automatic' },
];

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatExact(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

function Chevron() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden
      className="shrink-0 text-muted-foreground"
    >
      <path
        d="M5.2 3.2 L9 7 L5.2 10.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Rule opened in the history modal (from a row, or from a rule's History button). */
type OpenRule = {
  memoryId: string;
  key: string;
  category?: string;
  totalEventCount?: number;
  currentStatus?: string | null;
  visibility?: 'workspace' | 'user';
};

type MemoryActivityProps = {
  workspaceId: string | null;
  /** Workspace switch counter: everything is refetched, nothing carried over. */
  workspaceRevision: number;
  owner: string;
  repository: string;
  /** Opens the history modal of this rule (e.g. from a rule's History button). */
  ruleId: string | null;
  ruleLabel?: string | null;
  onClearRule: () => void;
  /** Changes when memory changed (refetch). */
  refreshKey: string | null;
};

/**
 * Project Memory activity: one compact row per memory rule (grouped by the rule's id on the
 * server, after the visibility rules), newest activity first; a rule's full history opens in
 * a modal. Personal-preference history is only ever returned to its owner.
 */
export function MemoryActivity({
  workspaceId,
  workspaceRevision,
  owner,
  repository,
  ruleId,
  ruleLabel,
  onClearRule,
  refreshKey,
}: MemoryActivityProps) {
  const [eventType, setEventType] = useState<'' | ProjectMemoryAuditEventType>('');
  const [actorType, setActorType] = useState<'' | ProjectMemoryAuditActorType>('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [rules, setRules] = useState<ProjectMemoryAuditRuleSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [openRule, setOpenRule] = useState<OpenRule | null>(null);
  /** Row that opened the modal: focus returns to it on close. */
  const [opener, setOpener] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Never keep a rule from another workspace / repository open.
  useEffect(() => {
    setOpenRule(null);
  }, [workspaceId, workspaceRevision, owner, repository]);

  // A rule's History button opens its modal directly (focus returns to that button).
  useEffect(() => {
    if (!ruleId) return;
    setOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setOpenRule({ memoryId: ruleId, key: ruleLabel ?? ruleId });
  }, [ruleId, ruleLabel]);

  const query = useCallback(
    (cursor?: string) => ({
      owner,
      repository,
      limit: RULES_PAGE_SIZE,
      ...(eventType ? { eventType } : {}),
      ...(actorType ? { actorType } : {}),
      ...(search ? { q: search } : {}),
      ...(cursor ? { cursor } : {}),
    }),
    [owner, repository, eventType, actorType, search],
  );

  useEffect(() => {
    // Never show results from another workspace / filter while the new ones load.
    setRules([]);
    setNextCursor(null);
    if (!workspaceId || !owner || !repository) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchMemoryAuditRules(workspaceId, query(), controller.signal)
      .then((page) => {
        setRules(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(safeErrorMessage(err, 'Unable to load activity.'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workspaceId, workspaceRevision, owner, repository, query, refreshKey, reloadTick]);

  async function loadMore() {
    if (!workspaceId || !nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchMemoryAuditRules(workspaceId, query(nextCursor));
      setRules((prev) => [
        ...prev,
        ...page.items.filter((rule) => !prev.some((p) => p.memoryId === rule.memoryId)),
      ]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(safeErrorMessage(err, 'Unable to load more activity.'));
    } finally {
      setLoadingMore(false);
    }
  }

  function closeModal() {
    setOpenRule(null);
    if (ruleId) onClearRule();
  }

  const filtered = Boolean(eventType || actorType || search);

  return (
    <section
      // The entrance animation keeps a transform, so each page section is its own stacking
      // context and later sections paint on top. Lift this one so the filter menus overlay
      // the sections below instead of being hidden under them.
      className="rise-in-delay-2 relative z-20 space-y-3"
      aria-labelledby="memory-activity-heading"
      data-testid="memory-activity"
    >
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <h2
          id="memory-activity-heading"
          className="font-display text-lg font-semibold tracking-tight"
        >
          Activity
        </h2>
        <button
          type="button"
          onClick={() => setReloadTick((n) => n + 1)}
          disabled={loading}
          className="rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
      <div className="space-y-4 rounded-3xl border border-line bg-panel/75 p-5 shadow-panel">
        <p className="text-xs text-muted-foreground">
          Changes to this repository&rsquo;s memory, one row per rule. History starts when activity
          logging was enabled; earlier changes are not shown. Personal preferences appear only to
          their owner.
        </p>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_14rem]">
          <div>
            <label htmlFor="memory-activity-search" className="text-sm font-semibold text-ink">
              Search
            </label>
            <input
              id="memory-activity-search"
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Rule key"
              maxLength={100}
              className="mt-2 w-full rounded-xl border border-line bg-mist px-3 py-2.5 text-sm text-ink outline-none ring-accent/30 transition placeholder:text-muted-foreground hover:border-accent/40 focus:ring-2"
            />
          </div>
          <StudioSelect
            id="memory-activity-event"
            label="Event"
            value={eventType || 'all'}
            options={EVENT_OPTIONS}
            onChange={(value) => setEventType(value === 'all' ? '' : value)}
          />
          <StudioSelect
            id="memory-activity-actor"
            label="Actor"
            value={actorType || 'all'}
            options={ACTOR_OPTIONS}
            onChange={(value) => setActorType(value === 'all' ? '' : value)}
          />
        </div>

        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-sm text-ink"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setReloadTick((n) => n + 1)}
              className="rounded-lg border border-line px-2 py-1 text-xs font-semibold"
            >
              Retry
            </button>
          </div>
        ) : null}
        {loading && rules.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading activity…
          </p>
        ) : null}
        {!loading && !error && rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {filtered
              ? 'No rules match these filters.'
              : 'No recorded activity for this repository yet.'}
          </p>
        ) : null}

        {rules.length > 0 ? (
          <ul
            className="divide-y divide-line/80 overflow-hidden rounded-2xl border border-line"
            aria-label="Memory rules with activity"
          >
            {rules.map((rule) => (
              <li key={rule.memoryId}>
                <button
                  type="button"
                  onClick={(event) => {
                    setOpener(event.currentTarget);
                    setOpenRule({
                      memoryId: rule.memoryId,
                      key: rule.key,
                      category: rule.category,
                      totalEventCount: rule.totalEventCount,
                      currentStatus: rule.currentStatus,
                      visibility: rule.visibility,
                    });
                  }}
                  className="flex w-full items-center gap-3 bg-panel px-4 py-2.5 text-left transition hover:bg-mist/70 focus-visible:bg-mist/70 focus-visible:outline-none"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-sm font-semibold text-ink">
                        {rule.key}
                      </span>
                      <span className="shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {rule.category}
                      </span>
                      {rule.visibility === 'user' ? (
                        <span className="shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-ink">
                          Personal
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      <span className="font-semibold text-ink">
                        {AUDIT_EVENT_LABELS[rule.latestEvent.eventType] ??
                          rule.latestEvent.eventType}
                      </span>{' '}
                      by {auditActorLabel(rule.latestEvent)} ·{' '}
                      {formatWhen(rule.latestEvent.createdAt)}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {ruleEventCountLabel(rule)}
                  </span>
                  <Chevron />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {nextCursor ? (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more rules'}
          </button>
        ) : null}
      </div>

      <RuleHistoryDialog
        workspaceId={workspaceId}
        rule={openRule}
        onClose={closeModal}
        returnFocusTo={opener}
      />
    </section>
  );
}

/** Complete authorized history of one rule (page filters do not apply), newest first. */
function RuleHistoryDialog({
  workspaceId,
  rule,
  onClose,
  returnFocusTo,
}: {
  workspaceId: string | null;
  rule: OpenRule | null;
  onClose: () => void;
  returnFocusTo: HTMLElement | null;
}) {
  const [events, setEvents] = useState<ProjectMemoryAuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const memoryId = rule?.memoryId ?? null;

  useEffect(() => {
    setEvents([]);
    setNextCursor(null);
    setError(null);
    if (!workspaceId || !memoryId) return;
    const controller = new AbortController();
    setLoading(true);
    fetchMemoryAudit(workspaceId, { memoryId, limit: HISTORY_PAGE_SIZE }, controller.signal)
      .then((page) => {
        setEvents(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(safeErrorMessage(err, 'Unable to load history.'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workspaceId, memoryId, retryTick]);

  async function loadMore() {
    if (!workspaceId || !memoryId || !nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchMemoryAudit(workspaceId, {
        memoryId,
        limit: HISTORY_PAGE_SIZE,
        cursor: nextCursor,
      });
      setEvents((prev) => [...prev, ...page.items.filter((e) => !prev.some((p) => p.id === e.id))]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(safeErrorMessage(err, 'Unable to load more history.'));
    } finally {
      setLoadingMore(false);
    }
  }

  const newest = events[0];
  const category = rule?.category ?? newest?.category;
  const status = rule?.currentStatus ?? newest?.newState?.status ?? null;
  const personal = (rule?.visibility ?? newest?.visibility) === 'user';

  return (
    <Dialog
      open={rule !== null}
      onClose={onClose}
      closeLabel="Close history"
      returnFocusTo={returnFocusTo}
      title={<span className="font-mono">{rule?.key}</span>}
      subtitle={
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {category ? (
            <span className="rounded-md border border-line px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              {category}
            </span>
          ) : null}
          {status ? (
            <span className="rounded-md bg-mist px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink">
              {status}
            </span>
          ) : null}
          {personal ? (
            <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-ink">
              Personal · only you
            </span>
          ) : null}
          {rule?.totalEventCount !== undefined ? (
            <span>
              {rule.totalEventCount} event{rule.totalEventCount === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
      }
      footer={
        nextCursor ? (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load older events'}
          </button>
        ) : undefined
      }
    >
      {error ? (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-sm text-ink"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setRetryTick((n) => n + 1)}
            className="rounded-lg border border-line px-2 py-1 text-xs font-semibold"
          >
            Retry
          </button>
        </div>
      ) : null}
      {loading && events.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading history…
        </p>
      ) : null}
      {!loading && !error && events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recorded activity for this rule.</p>
      ) : null}
      {events.length > 0 ? (
        <ol className="relative space-y-4 border-l border-line pl-5" aria-label="Rule history">
          {events.map((event) => (
            <HistoryEntry key={event.id} event={event} />
          ))}
        </ol>
      ) : null}
    </Dialog>
  );
}

function HistoryEntry({ event }: { event: ProjectMemoryAuditEvent }) {
  const before = event.previousState;
  const after = event.newState;
  const reason = auditReasonLabel(event.reason);
  const statusChanged = Boolean(before?.status && after?.status && before.status !== after.status);
  const textChanged =
    before?.text !== undefined && after?.text !== undefined && before.text !== after.text;
  const createdText = !before && after?.text ? after.text : null;
  const scopeChanged =
    before?.scope !== undefined &&
    after?.scope !== undefined &&
    JSON.stringify(before.scope) !== JSON.stringify(after.scope);
  const confidenceChanged = Boolean(
    before?.confidence && after?.confidence && before.confidence !== after.confidence,
  );

  return (
    <li className="relative">
      <span
        aria-hidden
        className={[
          'absolute -left-[1.6rem] top-1 h-2.5 w-2.5 rounded-full border-2 border-panel',
          event.actorType === 'system' ? 'bg-muted-foreground' : 'bg-accent',
        ].join(' ')}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">
          {AUDIT_EVENT_LABELS[event.eventType] ?? event.eventType}
        </span>
        {event.actorType === 'system' ? (
          <span className="rounded-md bg-mist px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
            Automatic
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {auditActorLabel(event)} ·{' '}
        <time dateTime={event.createdAt}>{formatExact(event.createdAt)}</time>
        {reason ? ` · ${reason}` : ''}
      </p>
      {statusChanged ? (
        <p className="mt-1.5 text-xs text-ink">
          Status: <span className="text-muted-foreground">{before!.status}</span> →{' '}
          <span className="font-semibold">{after!.status}</span>
        </p>
      ) : null}
      {confidenceChanged ? (
        <p className="mt-1 text-xs text-ink">
          Confidence: <span className="text-muted-foreground">{before!.confidence}</span> →{' '}
          <span className="font-semibold">{after!.confidence}</span>
        </p>
      ) : null}
      {scopeChanged ? <p className="mt-1 text-xs text-ink">Scope changed</p> : null}
      {textChanged ? (
        <div className="mt-2 grid gap-1.5 text-xs">
          <div className="rounded-lg border border-line bg-mist/50 px-2.5 py-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Previous
            </p>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground line-through decoration-muted-foreground/50">
              {before!.text}
            </p>
          </div>
          <div className="rounded-lg border border-accent/30 bg-accent-soft/40 px-2.5 py-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-accent">New</p>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-ink">{after!.text}</p>
          </div>
        </div>
      ) : null}
      {createdText ? (
        <p className="mt-1.5 whitespace-pre-wrap break-words rounded-lg border border-line bg-mist/50 px-2.5 py-1.5 text-xs text-ink">
          {createdText}
        </p>
      ) : null}
      {event.relatedMemoryId ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Related rule <span className="font-mono">{event.relatedMemoryId}</span>
        </p>
      ) : null}
    </li>
  );
}
