'use client';

import Link from 'next/link';
import type {
  MultiRepoRepositoryRole,
  ProjectSystem,
  ProjectSystemRepositoryRef,
  RelatedRepositoryCandidate,
  RepositoryRelationship,
} from '@project-x/types';

import { StudioSelect } from '../studio-select';
import {
  CANDIDATE_RELATIONSHIP_LABELS,
  PROVENANCE_LABELS,
  RELATIONSHIP_TYPE_LABELS,
  ROLE_OPTIONS,
  candidateKey,
  plural,
  repoLabel,
  sameRepo,
  type AnalysisUsage,
} from './systems-model';
import {
  BUTTON_ACCENT,
  BUTTON_GHOST,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  Badge,
  InlineEmpty,
  SectionCard,
  Spinner,
} from './systems-ui';

export type Operation = 'refresh' | 'discover' | 'mutate' | null;

// ── selector + primary actions ───────────────────────────────────────────────

export function SystemSelectorCard({
  systems,
  selected,
  operation,
  lastValidated,
  usage,
  analysisBlocked,
  onSelect,
  onRefresh,
  onDiscover,
  onOpenSettings,
  canManage = true,
}: {
  systems: ProjectSystem[];
  selected: ProjectSystem;
  operation: Operation;
  lastValidated: string | null;
  /** Monthly analysis usage, when the plan has a limit and the data is current. */
  usage: AnalysisUsage | null;
  /** A fresh scan cannot succeed (feature not in plan or no analyses left). */
  analysisBlocked: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onDiscover: () => void;
  onOpenSettings: () => void;
  /** systems:manage — System settings (rename / delete) only for Owners and Admins. */
  canManage?: boolean;
}) {
  const busy = operation !== null;
  return (
    <section
      aria-label="Selected system"
      className="rounded-3xl border border-line bg-panel/75 p-5 shadow-panel"
    >
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 flex-1 space-y-3">
          {systems.length > 1 ? (
            <div className="max-w-sm">
              <StudioSelect
                id="systems-select"
                label="System"
                value={selected.id}
                options={systems.map((s) => ({ value: s.id, label: s.name }))}
                onChange={onSelect}
              />
            </div>
          ) : null}
          <div className="min-w-0">
            <h2 className="break-words font-display text-2xl font-semibold tracking-tight text-ink">
              {selected.name}
            </h2>
            {/* Two lines instead of one dot-separated row: no orphaned separators when wrapping. */}
            <p className="mt-1 text-sm text-muted-foreground">
              Primary{' '}
              <span className="break-all font-mono font-medium text-ink">
                {repoLabel(selected.primaryRepository)}
              </span>
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {plural(selected.repositories.length, 'repository', 'repositories')}
              {lastValidated ? (
                <>
                  {' · '}
                  Relationships validated{' '}
                  <time dateTime={lastValidated}>{new Date(lastValidated).toLocaleString()}</time>
                </>
              ) : null}
            </p>
          </div>
        </div>
        {/* Full-width, equal buttons on phones; inline from `sm`. */}
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <button
            type="button"
            disabled={busy || analysisBlocked}
            onClick={onRefresh}
            aria-describedby="system-actions-help system-usage"
            className={BUTTON_ACCENT}
          >
            {operation === 'refresh' ? <Spinner /> : null}
            {operation === 'refresh' ? 'Analyzing…' : 'Refresh analysis'}
          </button>
          <button
            type="button"
            disabled={busy || analysisBlocked}
            onClick={onDiscover}
            aria-describedby="system-actions-help system-usage"
            className={BUTTON_SECONDARY}
          >
            {operation === 'discover' ? <Spinner /> : null}
            {operation === 'discover' ? 'Discovering…' : 'Discover relationships'}
          </button>
          {canManage ? (
            <button
              type="button"
              disabled={busy}
              onClick={onOpenSettings}
              className={BUTTON_SECONDARY}
            >
              System settings
            </button>
          ) : null}
        </div>
      </div>
      <div className="mt-4 space-y-1.5 border-t border-line/70 pt-3 text-xs leading-relaxed text-muted-foreground">
        <p id="system-actions-help">
          Both read the enabled repositories&apos; code, OpenAPI files and
          service-dependencies.json, and save the dependencies they can prove.{' '}
          <strong className="font-semibold text-ink">Refresh analysis</strong> gives a summary,
          including repositories that could not be read.{' '}
          <strong className="font-semibold text-ink">Discover relationships</strong> returns the
          full list with suggested repositories. Neither changes your GitHub repositories or adds
          repositories to the system.
        </p>
        <p id="system-usage">
          <strong className="font-semibold text-ink">Usage:</strong> each Refresh or Discover counts
          as one analysis toward your workspace&apos;s monthly limit. Viewing saved relationships is
          free.{' '}
          {usage ? (
            usage.remaining > 0 ? (
              <span>
                {usage.remaining} of {usage.limit} left this month.
              </span>
            ) : (
              <span className="font-semibold text-ink">
                No analyses left this month.{' '}
                <Link href="/app/billing" className="text-accent hover:underline">
                  Plan &amp; usage
                </Link>
              </span>
            )
          ) : null}
        </p>
      </div>
    </section>
  );
}

// ── overview ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-line bg-panel/75 px-4 py-3 shadow-panel">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * Counts come from loaded data only. Candidates / unavailable exist only after an analysis in
 * this session, so they show "—" until then (never an invented 0).
 */
export function SystemOverview({
  system,
  relationshipCount,
  relationshipsLoaded,
  candidateCount,
  unavailableCount,
}: {
  system: ProjectSystem;
  relationshipCount: number;
  relationshipsLoaded: boolean;
  candidateCount: number | null;
  unavailableCount: number | null;
}) {
  const enabled = system.repositories.filter((r) => r.enabled).length;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="System overview">
      <StatCard
        label="Repositories"
        value={String(system.repositories.length)}
        hint={`${enabled} enabled for analysis`}
      />
      <StatCard
        label="Known relationships"
        value={relationshipsLoaded ? String(relationshipCount) : '—'}
        hint="Between repositories in this system"
      />
      <StatCard
        label="Pending suggestions"
        value={candidateCount === null ? '—' : String(candidateCount)}
        hint={
          candidateCount === null ? 'Run an analysis to see suggestions' : 'Awaiting your review'
        }
      />
      <StatCard
        label="Unavailable"
        value={unavailableCount === null ? '—' : String(unavailableCount)}
        hint={unavailableCount === null ? 'Known after an analysis' : 'In the last analysis'}
      />
    </div>
  );
}

// ── repositories ─────────────────────────────────────────────────────────────

export function RepositoryList({
  system,
  operation,
  onAdd,
  onToggleEnabled,
  onChangeRole,
  onRemove,
  canManage = true,
}: {
  system: ProjectSystem;
  operation: Operation;
  /** systems:manage — without it the list is read-only (the API refuses changes anyway). */
  canManage?: boolean;
  onAdd: () => void;
  onToggleEnabled: (ref: ProjectSystemRepositoryRef) => void;
  onChangeRole: (ref: ProjectSystemRepositoryRef, role: MultiRepoRepositoryRole) => void;
  onRemove: (ref: ProjectSystemRepositoryRef) => void;
}) {
  const busy = operation !== null;
  const onlyPrimary = system.repositories.length <= 1;
  return (
    <SectionCard
      id="system-repositories"
      title="Repositories"
      description="The GitHub repositories grouped in this system. Enabled repositories take part in analysis; roles help describe how they fit together."
      actions={
        canManage ? (
          <button type="button" disabled={busy} onClick={onAdd} className={BUTTON_PRIMARY}>
            Add repository
          </button>
        ) : undefined
      }
    >
      <ul className="divide-y divide-line/70">
        {system.repositories.map((ref) => {
          const label = repoLabel(ref.repository);
          const isPrimary = sameRepo(ref.repository, system.primaryRepository);
          const nameId = `repo-name-${(ref.id ?? label).replace(/[^A-Za-z0-9_-]/g, '-')}`;
          return (
            <li
              key={ref.id ?? label}
              className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0 md:flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span id={nameId} className="break-all font-mono text-sm font-semibold text-ink">
                    {label}
                  </span>
                  {isPrimary ? <Badge tone="accent">Primary</Badge> : null}
                  {!ref.enabled ? <Badge tone="muted">Disabled</Badge> : null}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {ref.source === 'deterministic_link'
                    ? 'Added from a suggestion'
                    : ref.source === 'project_memory'
                      ? 'Added from Project Memory'
                      : 'Added manually'}
                </p>
              </div>
              <div
                role="group"
                aria-labelledby={nameId}
                className="flex flex-wrap items-end gap-3 md:shrink-0 md:flex-nowrap"
              >
                {canManage ? (
                  <div className="w-44">
                    <StudioSelect
                      id={`role-${label}`}
                      label="Role"
                      value={ref.role}
                      options={ROLE_OPTIONS}
                      onChange={(role) => onChangeRole(ref, role)}
                    />
                  </div>
                ) : (
                  <Badge tone="neutral">
                    {ROLE_OPTIONS.find((o) => o.value === ref.role)?.label ?? ref.role}
                  </Badge>
                )}
                <label
                  className="flex h-[42px] items-center gap-2 text-xs font-semibold text-ink"
                  title={isPrimary ? 'The primary repository is always analyzed' : undefined}
                >
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`Analyze ${label}`}
                    checked={ref.enabled}
                    disabled={busy || isPrimary || !canManage}
                    onChange={() => onToggleEnabled(ref)}
                    className="size-4"
                  />
                  Analyze
                </label>
                {!isPrimary && canManage ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRemove(ref)}
                    aria-label={`Remove ${label} from system`}
                    className={`${BUTTON_GHOST} h-[42px]`}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {onlyPrimary ? (
        <p className="mt-4 rounded-2xl bg-mist/60 px-4 py-3 text-sm text-muted-foreground">
          This system has only its primary repository. Add the services, libraries or contracts it
          works with to analyze dependencies across them.
        </p>
      ) : null}
    </SectionCard>
  );
}

// ── relationships ────────────────────────────────────────────────────────────

const CONFIDENCE_TONE = { high: 'accent', medium: 'neutral', low: 'muted' } as const;

export function RelationshipList({
  relationships,
  loaded,
  analyzed,
  operation,
  onAnalyze,
}: {
  relationships: RepositoryRelationship[];
  loaded: boolean;
  analyzed: boolean;
  operation: Operation;
  /** Empty-state action: Refresh analysis (finds the same relationships). */
  onAnalyze: () => void;
}) {
  return (
    <SectionCard
      id="system-relationships"
      title="Relationships"
      description="Dependencies found between repositories in this system, with the evidence behind them. Only what Project X could verify in the selected repositories is shown."
    >
      {!loaded ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading relationships…
        </p>
      ) : relationships.length === 0 ? (
        <InlineEmpty
          title={analyzed ? 'No relationships found' : 'No relationships yet'}
          description={
            analyzed
              ? 'The last analysis found no dependencies between these repositories. That is normal for a single repository or for independent services.'
              : 'Relationships appear after Project X analyzes the repositories in this system. Nothing is required — run an analysis when you are ready.'
          }
          action={
            <button
              type="button"
              disabled={operation !== null}
              onClick={onAnalyze}
              className={BUTTON_SECONDARY}
            >
              Refresh analysis
            </button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {relationships.map((rel) => (
            <li key={rel.id} className="rounded-2xl border border-line bg-mist/40 px-4 py-3">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="font-mono font-semibold text-ink">{repoLabel(rel.from)}</span>
                <span className="text-muted-foreground" aria-hidden>
                  →
                </span>
                <span className="sr-only">to</span>
                <span className="font-mono font-semibold text-ink">{repoLabel(rel.to)}</span>
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge>{RELATIONSHIP_TYPE_LABELS[rel.type] ?? rel.type}</Badge>
                {rel.resource ? (
                  <Badge tone="muted">
                    <span className="font-mono">{rel.resource.key}</span>
                  </Badge>
                ) : null}
                <Badge tone={CONFIDENCE_TONE[rel.confidence] ?? 'muted'}>
                  {rel.confidence[0]!.toUpperCase() + rel.confidence.slice(1)} confidence
                </Badge>
                {rel.status !== 'active' ? (
                  <Badge tone="muted">
                    {rel.status === 'disputed' ? 'Disputed' : 'Superseded'}
                  </Badge>
                ) : null}
              </div>
              {rel.provenance.length > 0 ? (
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none font-semibold text-ink/80 hover:text-ink">
                    Evidence ({rel.provenance.length})
                  </summary>
                  <ul className="mt-2 space-y-1.5">
                    {rel.provenance.map((p, i) => (
                      <li key={`${p.type}-${i}`}>
                        <span className="font-semibold text-ink">
                          {PROVENANCE_LABELS[p.type] ?? p.type}
                        </span>
                        {p.filePath ? (
                          <span className="ml-1 font-mono">
                            {p.repository ? `${p.repository}/` : ''}
                            {p.filePath}
                          </span>
                        ) : null}
                        <span className="block">{p.summary}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ── candidates ───────────────────────────────────────────────────────────────

export function CandidateList({
  candidates,
  analyzed,
  operation,
  onAccept,
  onDismiss,
  onRefresh,
  canManage = true,
}: {
  candidates: RelatedRepositoryCandidate[];
  /** systems:manage — adding a suggestion changes the system. */
  canManage?: boolean;
  analyzed: boolean;
  operation: Operation;
  onAccept: (candidate: RelatedRepositoryCandidate) => void;
  onDismiss: (candidate: RelatedRepositoryCandidate) => void;
  onRefresh: () => void;
}) {
  const busy = operation !== null;
  return (
    <SectionCard
      id="system-candidates"
      title="Suggested repositories"
      description="Repositories outside this system that may be related. Suggestions are never added automatically — review each one. Dismissing hides it for this visit only."
    >
      {!analyzed ? (
        <InlineEmpty
          title="No suggestions yet"
          description="Suggestions come from an analysis. Run one to see repositories that may belong in this system."
          action={
            <button type="button" disabled={busy} onClick={onRefresh} className={BUTTON_SECONDARY}>
              Refresh analysis
            </button>
          }
        />
      ) : candidates.length === 0 ? (
        <InlineEmpty
          title="No suggestions to review"
          description="The last analysis did not suggest any additional repositories. You can still add repositories manually."
        />
      ) : (
        <ul className="space-y-2">
          {candidates.map((candidate) => {
            const label = repoLabel(candidate.repository);
            const notRecommended = candidate.recommendation === 'do_not_add';
            return (
              <li
                key={candidateKey(candidate)}
                className="flex flex-col gap-3 rounded-2xl border border-line bg-mist/40 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="break-all font-mono text-sm font-semibold text-ink">{label}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <Badge>{CANDIDATE_RELATIONSHIP_LABELS[candidate.relationship]}</Badge>
                    <Badge tone={CONFIDENCE_TONE[candidate.confidence] ?? 'muted'}>
                      {candidate.confidence[0]!.toUpperCase() + candidate.confidence.slice(1)}{' '}
                      confidence
                    </Badge>
                    {notRecommended ? <Badge tone="muted">Not recommended</Badge> : null}
                  </div>
                  {candidate.evidence.length > 0 ? (
                    <details className="mt-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer select-none font-semibold text-ink/80 hover:text-ink">
                        Why this was suggested ({candidate.evidence.length})
                      </summary>
                      <ul className="mt-2 space-y-1.5">
                        {candidate.evidence.map((e, i) => (
                          <li key={i}>
                            {e.filePath ? (
                              <span className="font-mono text-ink">{e.filePath} </span>
                            ) : null}
                            {e.summary}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {canManage ? (
                    <button
                      type="button"
                      disabled={busy || notRecommended}
                      title={
                        notRecommended ? 'Project X does not recommend adding this one' : undefined
                      }
                      onClick={() => onAccept(candidate)}
                      className={BUTTON_PRIMARY}
                      aria-label={`Add ${label} to system`}
                    >
                      Add to system
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onDismiss(candidate)}
                    className={BUTTON_SECONDARY}
                    aria-label={`Dismiss ${label}`}
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

export function GithubConnectionNotice() {
  return (
    <div className="rounded-2xl border border-line bg-mist/60 px-4 py-3 text-sm">
      <p className="font-semibold text-ink">Connect GitHub to use Systems</p>
      <p className="mt-1 text-muted-foreground">
        Systems use your personal GitHub connection to confirm you can access each repository.
        Nothing is changed in GitHub.
      </p>
      <Link
        href="/app/settings"
        className="mt-2 inline-block text-sm font-semibold text-accent hover:underline"
      >
        Connect GitHub in Settings
      </Link>
    </div>
  );
}
