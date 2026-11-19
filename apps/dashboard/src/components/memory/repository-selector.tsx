'use client';

import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';

import {
  filterRepositoryGroups,
  parseRepositoryInput,
  type RepositoryGroup,
  type RepositoryOption,
} from './repository-selection';

type Props = {
  selected: RepositoryOption | null;
  groups: RepositoryGroup[];
  /** Suggestions are still loading (recent repositories are shown immediately). */
  loadingSuggestions?: boolean;
  disabled?: boolean;
  onSelect: (repository: RepositoryOption) => void;
  onClear: () => void;
};

type Row = { id: string; option: RepositoryOption; manual?: boolean };

/**
 * Searchable repository picker (WAI-ARIA combobox): recent, Systems and Review History
 * suggestions, plus any `owner/repository` or github.com URL typed by the user.
 */
export function RepositorySelector({
  selected,
  groups,
  loadingSuggestions = false,
  disabled = false,
  onSelect,
  onClear,
}: Props) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const visible = useMemo(() => filterRepositoryGroups(groups, query), [groups, query]);
  const manual = useMemo(() => {
    const option = parseRepositoryInput(query);
    if (!option) return null;
    const listed = visible.some((g) => g.options.some((o) => o.fullName === option.fullName));
    return listed ? null : option;
  }, [query, visible]);
  const invalidManual =
    query.trim().length > 0 && /[/:]/.test(query) && !parseRepositoryInput(query);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    visible.forEach((g) =>
      g.options.forEach((option) =>
        out.push({ id: `${baseId}-${g.id}-${option.fullName}`, option }),
      ),
    );
    if (manual) out.push({ id: `${baseId}-manual`, option: manual, manual: true });
    return out;
  }, [visible, manual, baseId]);
  const activeRow = open ? rows[Math.min(active, rows.length - 1)] : undefined;

  function choose(option: RepositoryOption) {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    onSelect(option);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      if (rows.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (Math.min(i, rows.length - 1) + delta + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeRow) choose(activeRow.option);
    } else if (event.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  }

  let rowIndex = -1;
  const optionClass = (isActive: boolean, isSelected: boolean) =>
    [
      'flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 font-mono text-sm',
      isActive ? 'bg-accent/15 text-ink' : 'text-ink hover:bg-mist',
      isSelected ? 'font-semibold' : '',
    ].join(' ');

  return (
    <div className="relative">
      <label htmlFor={`${baseId}-input`} className="text-sm font-semibold text-ink">
        Repository
      </label>
      <div className="mt-2 flex items-center gap-2">
        <input
          ref={inputRef}
          id={`${baseId}-input`}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeRow?.id}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={selected ? selected.fullName : 'Search, or enter owner/repository'}
          value={open ? query : (selected?.fullName ?? '')}
          onFocus={() => {
            setOpen(true);
            setQuery('');
            setActive(0);
          }}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="w-full rounded-xl border border-line bg-mist px-3 py-2.5 font-mono text-sm text-ink outline-none ring-accent/30 placeholder:text-muted-foreground focus:ring-2 disabled:opacity-50"
        />
        {selected ? (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            aria-label={`Clear selected repository ${selected.fullName}`}
            className="shrink-0 rounded-xl border border-line px-3 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
          >
            Clear
          </button>
        ) : null}
      </div>

      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Repositories"
          className="absolute left-0 right-0 z-20 mt-2 max-h-80 overflow-y-auto rounded-2xl border border-line bg-panel p-2 shadow-panel"
          // Keep focus in the input while clicking an option.
          onMouseDown={(event) => event.preventDefault()}
        >
          {visible.map((group) => (
            <div key={group.id} role="group" aria-label={group.label} className="py-1">
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {group.label}
              </p>
              {group.options.map((option) => {
                rowIndex += 1;
                const row = rows[rowIndex]!;
                const isSelected = selected?.fullName === option.fullName;
                return (
                  <div
                    key={row.id}
                    id={row.id}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => choose(option)}
                    onMouseEnter={() => setActive(rowIndex)}
                    className={optionClass(activeRow?.id === row.id, isSelected)}
                  >
                    <span className="break-all">{option.fullName}</span>
                    {isSelected ? <span className="text-xs text-accent">Selected</span> : null}
                  </div>
                );
              })}
            </div>
          ))}

          {manual ? (
            <div className="border-t border-line/80 pt-1">
              <div
                id={`${baseId}-manual`}
                role="option"
                aria-selected={false}
                onClick={() => choose(manual)}
                className={optionClass(activeRow?.id === `${baseId}-manual`, false)}
              >
                <span className="break-all">
                  Use <span className="font-semibold">{manual.fullName}</span>
                </span>
              </div>
            </div>
          ) : null}

          {rows.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {invalidManual
                ? 'Enter owner/repository or a github.com repository URL.'
                : loadingSuggestions
                  ? 'Loading repositories…'
                  : query.trim()
                    ? 'No matching repositories. Enter owner/repository to use another one.'
                    : 'No suggestions yet. Enter owner/repository or a github.com URL.'}
            </p>
          ) : loadingSuggestions && !query.trim() ? (
            <p className="px-3 py-1 text-xs text-muted-foreground">Loading more repositories…</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
