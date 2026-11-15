import { ApiError, isWorkspaceSelectionError } from '../../../lib/api';
import { notify } from '../../../lib/notify';

export const MANAGE_DENIED_MESSAGE =
  'Your role in this workspace can no longer manage shared project memory. Ask an Owner or Admin.';

export const WORKSPACE_SELECTION_MESSAGE =
  'The selected workspace is no longer available to you. Nothing was changed. Your workspace list has been refreshed — check the workspace switcher and try again.';

export type MemoryNotice = string | { title: string; description?: string };

export type MemoryErrorHooks = {
  /** The selected workspace was rejected: re-bootstrap the workspace switcher. */
  onWorkspaceSelection?: () => void;
  /** Role changed mid-session (403): refresh permissions so the UI matches. */
  onForbidden?: () => void;
};

export type MemoryMutationOptions<T> = MemoryErrorHooks & {
  /** Shown while the request runs (long operations only, e.g. Learn / Clear). */
  loading?: string;
  /** Shown only after the server confirmed the change. */
  success: MemoryNotice | ((result: T) => MemoryNotice);
  /** Title of the error notification ("Could not archive rule"). */
  errorTitle: string;
  /**
   * Return true when the caller shows this error inline (form validation, edit conflicts);
   * no notification is raised for it.
   */
  handledInline?: (error: unknown) => boolean;
};

export type MemoryMutationResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

function asNotice(notice: MemoryNotice): { title: string; description?: string } {
  return typeof notice === 'string' ? { title: notice } : notice;
}

/**
 * Raise the notification for a failed Project Memory call. Messages are always safe:
 * workspace / permission cases use fixed copy, everything else goes through the shared
 * error normalization (no server internals, stack traces or credentials).
 * `replaceId` turns an existing (loading) notification into the error in place.
 */
export function reportMemoryError(
  title: string,
  error: unknown,
  hooks: MemoryErrorHooks = {},
  replaceId?: string,
): void {
  const at = replaceId ? { id: replaceId } : {};
  if (isWorkspaceSelectionError(error)) {
    notify.warning('Workspace no longer available', {
      ...at,
      description: WORKSPACE_SELECTION_MESSAGE,
    });
    hooks.onWorkspaceSelection?.();
    return;
  }
  // Only a role denial means "your role changed". Other 403s (GitHub access, plan) carry
  // their own explanation, which the normalized message shows.
  if (
    error instanceof ApiError &&
    error.statusCode === 403 &&
    error.code === 'WORKSPACE_ACCESS_DENIED'
  ) {
    notify.error(title, { ...at, description: MANAGE_DENIED_MESSAGE });
    hooks.onForbidden?.();
    return;
  }
  notify.apiError(title, error, at);
}

/**
 * Run one Project Memory mutation and report its real outcome: optional loading notification,
 * success only after the server confirmed, a safe error otherwise. Never throws.
 */
export async function runMemoryMutation<T>(
  operation: () => Promise<T>,
  options: MemoryMutationOptions<T>,
): Promise<MemoryMutationResult<T>> {
  const loadingId = options.loading
    ? notify.loading(options.loading, { dedupeKey: null })
    : undefined;
  try {
    const value = await operation();
    const notice = asNotice(
      typeof options.success === 'function' ? options.success(value) : options.success,
    );
    notify.success(notice.title, {
      ...(loadingId ? { id: loadingId } : {}),
      ...(notice.description ? { description: notice.description } : {}),
    });
    return { ok: true, value };
  } catch (error) {
    if (options.handledInline?.(error)) {
      if (loadingId) notify.dismiss(loadingId);
    } else {
      reportMemoryError(options.errorTitle, error, options, loadingId);
    }
    return { ok: false, error };
  }
}
