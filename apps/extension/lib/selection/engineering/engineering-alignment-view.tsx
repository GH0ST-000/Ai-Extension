import { useMemo } from 'react';
import {
  validateEngineeringAlignmentAnalysis,
  type ValidateAnalysisResult,
} from '@project-x/shared';
import type {
  AnalysisBinding,
  EngineeringAlignmentAnalysis,
  EngineeringContext,
} from '@project-x/types';

import { cn } from '~/lib/utils/cn';

function tryParseJson(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Model sometimes wraps JSON in prose — try first/last brace slice.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

export function parseEngineeringAlignmentContent(
  content: string,
  ctx: EngineeringContext | null,
  binding: AnalysisBinding | null,
): ValidateAnalysisResult | null {
  if (!ctx || !binding) {
    return null;
  }
  const raw = tryParseJson(content);
  if (raw == null) {
    return null;
  }
  return validateEngineeringAlignmentAnalysis(raw, ctx, binding);
}

const STATUS_LABEL: Record<string, string> = {
  covered: 'Covered',
  partial: 'Partial',
  'not-evident': 'Not evident',
  conflicting: 'Conflicting',
  uncertain: 'Uncertain',
};

export function EngineeringAlignmentView(props: {
  analysis: EngineeringAlignmentAnalysis;
  streaming?: boolean;
}) {
  const { analysis, streaming } = props;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-surface/70 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Alignment
          </p>
          <span className="rounded-md bg-icon px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-secondary">
            {analysis.alignment}
          </span>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-[1.55] text-primary">{analysis.overview}</p>
        {streaming ? <span className="mt-1 inline-block text-[11px] text-accent">0</span> : null}
      </div>

      {analysis.requirementCoverage.length > 0 ? (
        <section>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Requirements
          </p>
          <ul className="space-y-1.5">
            {analysis.requirementCoverage.map((item, index) => (
              <li
                key={`${item.criterionId ?? item.criterion}-${index}`}
                className="rounded-lg border border-border bg-surface/50 px-2 py-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[12px] font-medium leading-4 text-primary">{item.criterion}</p>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold',
                      item.status === 'covered' && 'bg-accent-soft text-accent',
                      item.status === 'conflicting' && 'bg-[rgba(225,29,72,0.12)] text-[#e11d48]',
                      item.status !== 'covered' &&
                        item.status !== 'conflicting' &&
                        'bg-icon text-muted',
                    )}
                  >
                    {STATUS_LABEL[item.status] ?? item.status}
                  </span>
                </div>
                {item.criterionSource === 'inferred' ? (
                  <p className="mt-0.5 text-[10px] text-muted">Inferred criterion</p>
                ) : null}
                {item.notes ? (
                  <p className="mt-1 text-[11px] leading-4 text-secondary">{item.notes}</p>
                ) : null}
                {item.evidence.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {item.evidence.slice(0, 3).map((ev, evIndex) => (
                      <li key={`${ev.label}-${evIndex}`} className="text-[10px] text-muted">
                        {ev.source}: {ev.label}
                        {ev.reference?.filePath ? ` · ${ev.reference.filePath}` : ''}
                        {ev.reference?.method && ev.reference?.path
                          ? ` · ${ev.reference.method} ${ev.reference.path}`
                          : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {analysis.crossContextConflicts.length > 0 ? (
        <section>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Conflicts
          </p>
          <ul className="space-y-1.5">
            {analysis.crossContextConflicts.map((conflict) => (
              <li
                key={conflict.id}
                className="rounded-lg border border-border bg-surface/50 px-2 py-1.5"
              >
                <p className="text-[12px] font-medium text-primary">{conflict.title}</p>
                <p className="mt-0.5 text-[11px] leading-4 text-secondary">
                  {conflict.description}
                </p>
                <p className="mt-1 text-[10px] uppercase tracking-wide text-muted">
                  {conflict.severity} · {conflict.sources.join(' + ')}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {analysis.risks.length > 0 ? (
        <section>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Risks
          </p>
          <ul className="space-y-1">
            {analysis.risks.slice(0, 6).map((risk, index) => (
              <li key={`${risk.title}-${index}`} className="text-[11px] leading-4 text-secondary">
                <span className="font-semibold text-primary">{risk.severity}</span> — {risk.title}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {analysis.openQuestions.length > 0 ? (
        <section>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Open questions
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {analysis.openQuestions.slice(0, 6).map((q) => (
              <li key={q} className="text-[11px] leading-4 text-secondary">
                {q}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {analysis.scope.partial || analysis.scope.limitations.length > 0 ? (
        <p className="text-[10px] leading-4 text-muted">
          Scope: partial analysis
          {analysis.scope.limitations.length
            ? ` — ${analysis.scope.limitations.slice(0, 3).join('; ')}`
            : ''}
        </p>
      ) : null}
    </div>
  );
}

export function useEngineeringAlignmentView(
  content: string,
  ctx: EngineeringContext | null,
  binding: AnalysisBinding | null,
): EngineeringAlignmentAnalysis | null {
  return useMemo(() => {
    const parsed = parseEngineeringAlignmentContent(content, ctx, binding);
    if (!parsed || !parsed.ok) {
      return null;
    }
    return parsed.analysis;
  }, [content, ctx, binding]);
}
