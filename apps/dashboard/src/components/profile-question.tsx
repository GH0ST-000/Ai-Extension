'use client';

/**
 * One optional single-choice question as a row of chips (radio group semantics). Clicking the
 * selected chip again clears the answer.
 */
export function ProfileQuestion<T extends string>({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  options: Record<T, string>;
  value: T | null;
  onChange: (value: T | null) => void;
}) {
  const entries = Object.entries(options) as [T, string][];
  return (
    <fieldset className="space-y-2" aria-labelledby={`${id}-label`}>
      <legend id={`${id}-label`} className="text-sm font-semibold text-ink">
        {label} <span className="font-normal text-muted-foreground">(optional)</span>
      </legend>
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="flex flex-wrap gap-2">
        {entries.map(([optionValue, optionLabel]) => {
          const selected = value === optionValue;
          return (
            <button
              key={optionValue}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(selected ? null : optionValue)}
              className={[
                'rounded-xl border px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                selected
                  ? 'border-accent bg-accent-soft font-semibold text-ink'
                  : 'border-line bg-panel/70 text-ink hover:bg-mist',
              ].join(' ')}
            >
              {optionLabel}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
