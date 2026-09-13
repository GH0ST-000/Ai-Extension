'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  BillingCycle,
  ProductPlanId,
  WorkspaceBillingView,
  WorkspaceUsageCounter,
} from '@project-x/types';
import { DEFAULT_PRODUCT_PLANS } from '@project-x/shared';

import { ApiError } from '../../../lib/api';
import { useWorkspace } from '../../../lib/workspace-context';
import {
  cancelSubscription,
  createCheckout,
  getBilling,
  getPortal,
  getUsage,
  refreshBilling,
} from '../../../lib/workspace-api';

function apiMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function formatDate(value?: string): string {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatMetric(metric: WorkspaceUsageCounter['metric']): string {
  switch (metric) {
    case 'ai_action':
      return 'AI Actions';
    case 'workflow_run':
      return 'Workflow Runs';
    case 'pr_review':
      return 'PR Reviews';
    case 'multi_repo_analysis':
      return 'Multi-Repo Analyses';
    default:
      return metric;
  }
}

function formatUsageCount(count: number, limit: number | null): string {
  if (limit == null) {
    return `${count} / Unlimited`;
  }
  return `${count} / ${limit}`;
}

function planBlurb(planId: ProductPlanId): string[] {
  const plan = DEFAULT_PRODUCT_PLANS.find((item) => item.id === planId);
  if (!plan) {
    return [];
  }
  const e = plan.entitlements;
  const lines: string[] = [];
  if (e.aiActions) {
    lines.push(
      e.monthlyAiActions == null
        ? 'Unlimited AI actions'
        : `${e.monthlyAiActions} AI actions / month`,
    );
  }
  if (e.workflowAgent) {
    lines.push('Developer workflow agent');
  } else {
    lines.push(
      e.monthlyWorkflowRuns == null
        ? 'Unlimited workflow runs'
        : `${e.monthlyWorkflowRuns} workflows / month`,
    );
  }
  if (e.projectMemory) {
    lines.push('Project Memory');
  }
  if (e.multiRepoIntelligence) {
    lines.push('Multi-Repo Intelligence');
  }
  lines.push(e.maxWorkspaceMembers === 1 ? '1 user' : `Up to ${e.maxWorkspaceMembers} members`);
  return lines.slice(0, 4);
}

export default function BillingPage() {
  const { ready, current, hasPermission, refresh: refreshWorkspace } = useWorkspace();
  const workspaceId = current?.workspace.id ?? null;

  const [billing, setBilling] = useState<WorkspaceBillingView | null>(null);
  const [usage, setUsage] = useState<WorkspaceUsageCounter[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('monthly');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canRead = hasPermission('billing:read');
  const canManage = hasPermission('billing:manage');

  const load = useCallback(async () => {
    if (!workspaceId || !canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextBilling, nextUsage] = await Promise.all([
        getBilling(workspaceId),
        getUsage(workspaceId),
      ]);
      setBilling(nextBilling);
      setUsage(nextUsage.length > 0 ? nextUsage : nextBilling.usage);
    } catch (err) {
      setError(apiMessage(err, 'Unable to load billing.'));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, canRead]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCheckout(planId: Exclude<ProductPlanId, 'free'>) {
    if (!workspaceId || !canManage) {
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const result = await createCheckout(workspaceId, { planId, billingCycle });
      if (result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      setMessage('Checkout started. Complete payment in the billing provider.');
      await load();
      await refreshWorkspace();
    } catch (err) {
      setError(apiMessage(err, 'Unable to start checkout.'));
    } finally {
      setBusy(false);
    }
  }

  async function onPortal() {
    if (!workspaceId || !canManage) {
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const result = await getPortal(workspaceId);
      window.location.assign(result.url);
    } catch (err) {
      setError(apiMessage(err, 'Unable to open billing portal.'));
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!workspaceId || !canManage) {
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await cancelSubscription(workspaceId);
      setMessage('Cancellation scheduled for the end of the billing period.');
      await load();
      await refreshWorkspace();
    } catch (err) {
      setError(apiMessage(err, 'Unable to cancel subscription.'));
    } finally {
      setBusy(false);
    }
  }

  async function onRefresh() {
    if (!workspaceId || !canManage) {
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const next = await refreshBilling(workspaceId);
      setBilling(next);
      setUsage(next.usage);
      setMessage('Billing status refreshed.');
      await refreshWorkspace();
    } catch (err) {
      setError(apiMessage(err, 'Unable to refresh billing.'));
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return (
      <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
        Loading billing…
      </div>
    );
  }

  if (!canRead) {
    return (
      <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
        You do not have permission to view billing for this workspace.
      </div>
    );
  }

  const currentPlanId = billing?.plan.id ?? current?.plan.id ?? 'free';

  return (
    <div className="space-y-8">
      <header className="rise-in">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">Billing</p>
        <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-ink">Plan</h1>
        <p className="mt-3 max-w-xl text-base text-muted-foreground">
          Manage subscription, seats, and usage for this workspace.
        </p>
      </header>

      {message ? (
        <p className="rounded-xl border border-accent bg-accent-soft px-3 py-2 text-sm text-ink">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-xl border border-line bg-panel px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {loading || !billing ? (
        <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
          {loading ? 'Loading billing…' : 'Billing unavailable.'}
        </div>
      ) : (
        <>
          <section className="rise-in-delay-1 space-y-3">
            <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Current plan</h2>
            <div className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel">
              <div className="grid gap-4 border-b border-line/80 px-5 py-4 sm:grid-cols-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Plan
                  </p>
                  <p className="mt-1 font-display text-2xl font-semibold text-ink">
                    {billing.plan.name}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Status
                  </p>
                  <p className="mt-1 text-sm font-semibold capitalize text-ink">
                    {billing.subscription.status.replaceAll('_', ' ')}
                    {billing.subscription.cancelAtPeriodEnd ? ' · cancels at period end' : ''}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Billing cycle
                  </p>
                  <p className="mt-1 text-sm font-semibold capitalize text-ink">
                    {billing.subscription.billingCycle ?? '—'}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Renews / ends
                  </p>
                  <p className="mt-1 text-sm font-semibold text-ink">
                    {formatDate(billing.subscription.currentPeriodEnd)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Seats
                  </p>
                  <p className="mt-1 text-sm font-semibold text-ink">
                    {billing.seats.used} / {billing.seats.limit}
                  </p>
                </div>
              </div>

              {canManage ? (
                <div className="flex flex-wrap gap-2 bg-mist/50 px-5 py-4">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onPortal()}
                    className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-50"
                  >
                    Manage billing
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onRefresh()}
                    className="rounded-xl border border-line px-4 py-2.5 text-sm font-semibold text-ink disabled:opacity-50"
                  >
                    Refresh status
                  </button>
                  {billing.subscription.planId !== 'free' &&
                  billing.subscription.status !== 'cancelled' &&
                  billing.subscription.status !== 'none' ? (
                    <button
                      type="button"
                      disabled={busy || Boolean(billing.subscription.cancelAtPeriodEnd)}
                      onClick={() => void onCancel()}
                      className="rounded-xl border border-line px-4 py-2.5 text-sm font-semibold text-ink disabled:opacity-50"
                    >
                      {billing.subscription.cancelAtPeriodEnd
                        ? 'Cancel scheduled'
                        : 'Cancel subscription'}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          <section className="rise-in-delay-1 space-y-3">
            <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Usage</h2>
            {usage.length === 0 ? (
              <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
                No usage tracked for this period yet.
              </div>
            ) : (
              <ul className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel">
                {usage.map((row) => (
                  <li
                    key={`${row.metric}-${row.period}`}
                    className="flex items-center justify-between gap-3 border-b border-line/80 px-5 py-4 last:border-b-0"
                  >
                    <div>
                      <p className="text-sm font-semibold text-ink">{formatMetric(row.metric)}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">Period {row.period}</p>
                    </div>
                    <p className="text-sm font-semibold text-ink">
                      {formatUsageCount(row.count, row.limit)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section className="rise-in-delay-1 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3 px-1">
          <h2 className="font-display text-lg font-semibold tracking-tight">Plans</h2>
          {canManage ? (
            <div className="flex gap-2">
              {(['monthly', 'yearly'] as const).map((cycle) => (
                <button
                  key={cycle}
                  type="button"
                  onClick={() => setBillingCycle(cycle)}
                  className={[
                    'rounded-lg border px-2.5 py-1 text-xs font-semibold capitalize',
                    billingCycle === cycle
                      ? 'border-accent bg-accent-soft text-ink'
                      : 'border-line bg-panel text-muted-foreground',
                  ].join(' ')}
                >
                  {cycle}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {DEFAULT_PRODUCT_PLANS.map((item) => {
            const active = item.id === currentPlanId;
            const isPaid = item.id !== 'free';
            return (
              <div
                key={item.id}
                className={[
                  'rounded-3xl border px-5 py-5 shadow-panel',
                  active ? 'border-accent bg-accent-soft' : 'border-line bg-panel/75',
                ].join(' ')}
              >
                <p className="font-display text-xl font-semibold text-ink">{item.name}</p>
                <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
                  {planBlurb(item.id).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {canManage && isPaid && !active ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onCheckout(item.id as Exclude<ProductPlanId, 'free'>)}
                    className="mt-4 rounded-xl bg-ink px-3.5 py-2 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-50"
                  >
                    Upgrade to {item.name}
                  </button>
                ) : null}
                {active ? (
                  <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink">
                    Current
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
