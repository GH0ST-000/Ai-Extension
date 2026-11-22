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
  /** `compact` matches the small inputs of filter bars (same height, radius and label). */
  size?: 'default' | 'compact';
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
  const listRef = useRef<HTMLUListElement>(null);
  const compact = props.size === 'compact';

  // Opening moves focus to the selected option so the arrow keys work straight away.
  useEffect(() => {
    if (!open) return;
    const options = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    const current = Array.from(options ?? []).find(
      (o) => o.getAttribute('aria-selected') === 'true',
    );
    (current ?? options?.[0])?.focus();
  }, [open]);

  function onListKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
    );
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => {
      event.preventDefault();
      options[(next + options.length) % options.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(options.length - 1);
    else if (event.key === 'Tab') setOpen(false);
  }

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
      <label
        htmlFor={buttonId}
        className={compact ? 'text-xs font-medium text-ink' : 'text-sm font-semibold text-ink'}
      >
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
          compact
            ? 'mt-1 flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-panel px-2.5 py-1.5'
            : 'mt-2 flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-mist px-3 py-2.5',
          compact
            ? 'text-left text-sm text-ink outline-none transition'
            : 'text-left text-sm font-semibold text-ink outline-none transition',
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
          ref={listRef}
          role="listbox"
          aria-labelledby={buttonId}
          onKeyDown={onListKeyDown}
          className={[
            'absolute z-30 max-h-64 w-full min-w-max overflow-auto border border-line bg-panel shadow-panel',
            compact ? 'mt-1 rounded-xl py-1' : 'mt-2 rounded-2xl py-1.5',
          ].join(' ')}
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
                    'flex w-full items-center justify-between gap-3 text-left text-sm outline-none transition focus-visible:bg-mist',
                    compact ? 'px-2.5 py-1.5' : 'px-3 py-2',
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
