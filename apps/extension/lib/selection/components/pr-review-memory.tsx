import { useState } from 'react';
import type { ProjectMemoryPromptMetadata } from '@project-x/types';

import {
  memoryCategoryLabel,
  memoryChipLabel,
  memorySkipReasonText,
} from '../utils/project-memory-metadata';

/**
 * Which project memory rules were applied to this review's prompt. Data comes only from
 * the API response for this request (rules the user may read in the acting workspace).
 */
export function PrReviewMemory({ metadata }: { metadata: ProjectMemoryPromptMetadata | null }) {
  const [open, setOpen] = useState(false);
  const label = memoryChipLabel(metadata);
  if (!metadata || !label) {
    return null;
  }

  return (
    <div className="rounded-lg border border-border bg-surface/60 px-2.5 py-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 text-left text-[10px] font-semibold text-secondary hover:text-primary"
      >
        <span>Project memory · {label}</span>
        <span aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        metadata.status === 'skipped' ? (
          <p className="mt-1 text-[11px] leading-4 text-muted">
            {memorySkipReasonText(metadata.reason)}
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {metadata.rules.map((rule) => (
              <li key={rule.id} className="text-[11px] leading-4">
                <p className="break-words text-primary">{rule.title || rule.key}</p>
                <p className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-muted">
                  <span className="rounded bg-hover px-1 py-px">
                    {memoryCategoryLabel(rule.category)}
                  </span>
                  <span className="rounded bg-hover px-1 py-px">{rule.confidence}</span>
                  {rule.visibility === 'user' ? (
                    <span className="rounded bg-hover px-1 py-px" title="Visible only to you">
                      personal
                    </span>
                  ) : null}
                </p>
              </li>
            ))}
            <li className="text-[10px] text-muted">Memory version {metadata.version}</li>
          </ul>
        )
      ) : null}
    </div>
  );
}
