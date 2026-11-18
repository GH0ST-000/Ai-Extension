'use client';

import Link from 'next/link';
import { type FormEvent, type RefObject, useEffect, useRef, useState } from 'react';
import type { MultiRepoRepositoryRole, ProjectSystem } from '@project-x/types';

import { Dialog } from '../dialog';
import { StudioSelect } from '../studio-select';
import {
  ROLE_OPTIONS,
  parseRepositoryInput,
  repoLabel,
  sameRepo,
  type ErrorGuidance,
} from './systems-model';
import {
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  Callout,
  INPUT_CLASS,
  Spinner,
} from './systems-ui';

/** Async submit: resolves to null on success (dialog closes) or an error to show inline. */
type Submit<T> = (value: T) => Promise<ErrorGuidance | null>;

function DialogError({ error }: { error: ErrorGuidance | null }) {
  if (!error) return null;
  return (
    <Callout
      tone="error"
      role="alert"
      title={error.title}
      action={
        error.action ? (
          <Link href={error.action.href} className={BUTTON_SECONDARY}>
            {error.action.label}
          </Link>
        ) : undefined
      }
    >
      {error.message}
    </Callout>
  );
}

function RepositoryField({
  id,
  label,
  value,
  error,
  onChange,
  inputRef,
}: {
  id: string;
  label: string;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
  inputRef?: RefObject<HTMLInputElement>;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="acme/payments-api"
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-2 font-mono ${INPUT_CLASS}`}
      />
      <p
        id={`${id}-hint`}
        className={`mt-1.5 text-xs ${error ? 'text-[#b42318] dark:text-[#f97066]' : 'text-muted-foreground'}`}
      >
        {error ??
          'owner/repository or a GitHub URL. You need access to it through your GitHub connection.'}
      </p>
    </div>
  );
}

/**
 * Form dialogs start with the first field focused. The shared Dialog focuses its close button
 * in its own (child) effect; this parent effect runs after it.
 */
function useInitialFocus(open: boolean, ref: RefObject<HTMLInputElement>) {
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open, ref]);
}

function useResetOnOpen(open: boolean, reset: () => void) {
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

// ── create ───────────────────────────────────────────────────────────────────

export function CreateSystemDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: Submit<{ name: string; owner: string; repository: string }>;
}) {
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [error, setError] = useState<ErrorGuidance | null>(null);
  const [pending, setPending] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useResetOnOpen(open, () => {
    setName('');
    setRepo('');
    setNameError(null);
    setRepoError(null);
    setError(null);
    setPending(false);
  });

  useInitialFocus(open, nameRef);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const trimmed = name.trim();
    const parsed = parseRepositoryInput(repo);
    setNameError(trimmed ? null : 'Give the system a name, e.g. “Checkout platform”.');
    setRepoError(parsed.ok ? null : parsed.error);
    if (!trimmed || !parsed.ok) return;
    setPending(true);
    setError(null);
    const result = await onSubmit({
      name: trimmed,
      owner: parsed.owner,
      repository: parsed.repository,
    });
    setPending(false);
    if (result) setError(result);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create system"
      className="max-w-lg"
      subtitle={
        <p className="text-sm text-muted-foreground">
          A system groups repositories that work together. Start with one — you can add more after
          it is created.
        </p>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="create-system-name" className="text-sm font-semibold text-ink">
            System name
          </label>
          <input
            ref={nameRef}
            id="create-system-name"
            type="text"
            autoComplete="off"
            maxLength={120}
            placeholder="Checkout platform"
            value={name}
            aria-invalid={nameError ? true : undefined}
            aria-describedby="create-system-name-hint"
            onChange={(event) => setName(event.target.value)}
            className={`mt-2 ${INPUT_CLASS}`}
          />
          <p
            id="create-system-name-hint"
            className={`mt-1.5 text-xs ${nameError ? 'text-[#b42318] dark:text-[#f97066]' : 'text-muted-foreground'}`}
          >
            {nameError ?? 'A short name your team recognizes.'}
          </p>
        </div>
        <RepositoryField
          id="create-system-repo"
          label="Primary repository"
          value={repo}
          error={repoError}
          onChange={setRepo}
        />
        <DialogError error={error} />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={BUTTON_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={pending} className={BUTTON_PRIMARY}>
            {pending ? <Spinner /> : null}
            {pending ? 'Creating…' : 'Create system'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ── add repository ───────────────────────────────────────────────────────────

export function AddRepositoryDialog({
  open,
  system,
  onClose,
  onSubmit,
}: {
  open: boolean;
  system: ProjectSystem | null;
  onClose: () => void;
  onSubmit: Submit<{
    owner: string;
    repository: string;
    role: MultiRepoRepositoryRole;
    enabled: boolean;
  }>;
}) {
  const [repo, setRepo] = useState('');
  const [role, setRole] = useState<MultiRepoRepositoryRole>('unknown');
  const [enabled, setEnabled] = useState(true);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [error, setError] = useState<ErrorGuidance | null>(null);
  const [pending, setPending] = useState(false);
  const repoRef = useRef<HTMLInputElement>(null);
  useResetOnOpen(open, () => {
    setRepo('');
    setRole('unknown');
    setEnabled(true);
    setRepoError(null);
    setError(null);
    setPending(false);
  });

  useInitialFocus(open, repoRef);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !system) return;
    const parsed = parseRepositoryInput(repo);
    if (!parsed.ok) {
      setRepoError(parsed.error);
      return;
    }
    if (system.repositories.some((r) => sameRepo(r.repository, parsed))) {
      setRepoError(`${parsed.owner}/${parsed.repository} is already in this system.`);
      return;
    }
    setRepoError(null);
    setPending(true);
    setError(null);
    const result = await onSubmit({
      owner: parsed.owner,
      repository: parsed.repository,
      role,
      enabled,
    });
    setPending(false);
    if (result) setError(result);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add repository"
      className="max-w-lg"
      subtitle={
        system ? (
          <p className="text-sm text-muted-foreground">
            Add a repository to <span className="font-semibold text-ink">{system.name}</span>.
            Project X checks that you can access it.
          </p>
        ) : null
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <RepositoryField
          id="add-repo"
          inputRef={repoRef}
          label="Repository"
          value={repo}
          error={repoError}
          onChange={setRepo}
        />
        <StudioSelect
          id="add-repo-role"
          label="Role (optional)"
          value={role}
          options={ROLE_OPTIONS}
          onChange={setRole}
        />
        <label className="flex items-start gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="mt-1"
          />
          <span>
            Include in analysis
            <span className="block text-xs text-muted-foreground">
              You can turn this off later without removing the repository.
            </span>
          </span>
        </label>
        <DialogError error={error} />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={BUTTON_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={pending} className={BUTTON_PRIMARY}>
            {pending ? <Spinner /> : null}
            {pending ? 'Adding…' : 'Add repository'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ── settings (rename + delete) ───────────────────────────────────────────────

export function SystemSettingsDialog({
  open,
  system,
  onClose,
  onRename,
  onDelete,
}: {
  open: boolean;
  system: ProjectSystem | null;
  onClose: () => void;
  onRename: Submit<string>;
  onDelete: () => Promise<ErrorGuidance | null>;
}) {
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<ErrorGuidance | null>(null);
  const [pending, setPending] = useState<'rename' | 'delete' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const settingsNameRef = useRef<HTMLInputElement>(null);
  useResetOnOpen(open, () => {
    setName(system?.name ?? '');
    setNameError(null);
    setError(null);
    setPending(null);
    setConfirmingDelete(false);
  });

  useInitialFocus(open, settingsNameRef);

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (pending || !system) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('The name cannot be empty.');
      return;
    }
    if (trimmed === system.name) {
      onClose();
      return;
    }
    setNameError(null);
    setPending('rename');
    setError(null);
    const result = await onRename(trimmed);
    setPending(null);
    if (result) setError(result);
  }

  async function confirmDelete() {
    if (pending) return;
    setPending('delete');
    setError(null);
    const result = await onDelete();
    setPending(null);
    if (result) setError(result);
  }

  return (
    <Dialog open={open} onClose={onClose} title="System settings" className="max-w-lg">
      {system ? (
        <div className="space-y-6">
          <form onSubmit={rename} className="space-y-3" noValidate>
            <div>
              <label htmlFor="system-settings-name" className="text-sm font-semibold text-ink">
                System name
              </label>
              <input
                ref={settingsNameRef}
                id="system-settings-name"
                type="text"
                autoComplete="off"
                maxLength={120}
                value={name}
                aria-invalid={nameError ? true : undefined}
                onChange={(event) => setName(event.target.value)}
                className={`mt-2 ${INPUT_CLASS}`}
              />
              {nameError ? (
                <p className="mt-1.5 text-xs text-[#b42318] dark:text-[#f97066]">{nameError}</p>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Primary repository:{' '}
              <span className="font-mono text-ink">{repoLabel(system.primaryRepository)}</span>
            </p>
            <div className="flex justify-end">
              <button type="submit" disabled={pending !== null} className={BUTTON_PRIMARY}>
                {pending === 'rename' ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>

          <DialogError error={error} />

          <div className="rounded-2xl border border-[#b42318]/30 px-4 py-3">
            <p className="text-sm font-semibold text-ink">Delete system</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Removes the system, its repository list and discovered relationships from Project X.
              Your GitHub repositories are not affected.
            </p>
            {confirmingDelete ? (
              <div className="mt-3 space-y-2" role="group" aria-label="Confirm deletion">
                <p className="text-sm font-semibold text-ink">
                  Delete “{system.name}”? This cannot be undone.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() => void confirmDelete()}
                    className={BUTTON_DANGER}
                  >
                    {pending === 'delete' ? 'Deleting…' : 'Yes, delete system'}
                  </button>
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() => setConfirmingDelete(false)}
                    className={BUTTON_SECONDARY}
                  >
                    Keep system
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className={`mt-3 ${BUTTON_DANGER}`}
              >
                Delete system…
              </button>
            )}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

// ── remove repository confirmation ───────────────────────────────────────────

export function ConfirmRemoveDialog({
  repository,
  pending,
  onCancel,
  onConfirm,
}: {
  repository: string | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={repository !== null}
      onClose={onCancel}
      title="Remove repository?"
      className="max-w-md"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={BUTTON_SECONDARY}>
            Cancel
          </button>
          <button type="button" disabled={pending} onClick={onConfirm} className={BUTTON_DANGER}>
            {pending ? 'Removing…' : 'Remove'}
          </button>
        </div>
      }
    >
      <p className="text-sm text-muted-foreground">
        <span className="font-mono font-semibold text-ink">{repository}</span> will no longer be
        part of this system and will not be included in future analyses. The GitHub repository
        itself is not affected. You can add it again later.
      </p>
    </Dialog>
  );
}
