import type { UsageMetric } from '@project-x/types';

/** Calendar-month usage periods (UTC). */
export function usagePeriodKey(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function usagePeriodResetAt(period: string): string {
  const [yearRaw, monthRaw] = period.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return new Date(Date.UTC(dateYear(), dateMonth() + 1, 1)).toISOString();
  }
  const next = new Date(Date.UTC(year, month, 1));
  return next.toISOString();
}

function dateYear(): number {
  return new Date().getUTCFullYear();
}

function dateMonth(): number {
  return new Date().getUTCMonth();
}

export const USAGE_METRICS: ReadonlyArray<UsageMetric> = [
  'ai_action',
  'workflow_run',
  'pr_review',
  'multi_repo_analysis',
];

export function isUsageMetric(value: string): value is UsageMetric {
  return (USAGE_METRICS as ReadonlyArray<string>).includes(value);
}
