'use client';

import { useEffect, useId, useRef, useState } from 'react';

export type StudioSelectOption<T extends string> = {
  value: T;
  label: string;
};

type StudioSelectProps<T extends string> = {
  id?: string;
  label: string;
  value: T;
  options: readonly StudioSelectOption<T>[];
  onChange: (value: T) => void;
  className?: string;
};

/**
 * Custom listbox styled for Signal Studio — avoids native OS select chrome.
 */
export function StudioSelect<T extends string>(props: StudioSelectProps<T>) {
  const generatedId = useId();
  const listboxId = `${props.id ?? generatedId}-listbox`;
  const buttonId = props.id ?? generatedId;
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const selected = props.options.find((option) => option.value === props.value) ?? props.options[0];

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={['relative', props.className].filter(Boolean).join(' ')}>
      <label htmlFor={buttonId} className="text-sm font-semibold text-ink">
        {props.label}
      </label>
      <button
        id={buttonId}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((prev) => !prev)}
        className={[
          'mt-2 flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-mist px-3 py-2.5',
          'text-left text-sm font-semibold text-ink outline-none transition',
          'ring-accent/30 hover:border-accent/40 focus:ring-2',
          open ? 'border-accent/50 ring-2' : '',
        ].join(' ')}
      >
        <span>{selected?.label ?? 'Select'}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden
          className={[
            'shrink-0 text-muted-foreground transition-transform duration-200',
            open ? 'rotate-180 text-accent' : '',
          ].join(' ')}
        >
          <path
            d="M3.2 5.2 L7 9 L10.8 5.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-labelledby={buttonId}
          className="absolute z-30 mt-2 max-h-64 w-full overflow-auto rounded-2xl border border-line bg-panel py-1.5 shadow-panel"
        >
          {props.options.map((option) => {
            const isSelected = option.value === props.value;
            return (
              <li key={option.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    props.onChange(option.value);
                    setOpen(false);
                  }}
                  className={[
                    'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition',
                    isSelected
                      ? 'bg-accent-soft font-semibold text-ink'
                      : 'font-medium text-ink hover:bg-mist',
                  ].join(' ')}
                >
                  <span>{option.label}</span>
                  {isSelected ? (
                    <span className="text-accent" aria-hidden>
                      ✓
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
