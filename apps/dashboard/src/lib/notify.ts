import {
  createNotificationStore,
  createNotifier,
  normalizeError,
  type NormalizedError,
  type NotificationOptions,
  type Notifier,
} from '@project-x/shared';

/** Exit animation length; the renderer's CSS uses the same value. */
export const NOTIFICATION_EXIT_MS = 180;

/**
 * The dashboard's single notification store. Module-level, so notifications survive client-side
 * navigation (the renderer is mounted once in the root layout). Only client code calls it.
 */
export const notificationStore = createNotificationStore({
  exitDurationMs: NOTIFICATION_EXIT_MS,
  maxVisible: 4,
});

export type DashboardNotifier = Notifier & {
  /**
   * Error notification for a failed API call: the description is always the safe, normalized
   * message (never raw server internals). Returns the id and the normalized error.
   */
  apiError(
    title: string,
    error: unknown,
    options?: Omit<NotificationOptions, 'description'> & { fallback?: string },
  ): { id: string; error: NormalizedError };
};

const base = createNotifier(notificationStore);

/**
 * Dashboard notification API:
 *
 *   notify.success('Rule saved', 'Applied to the next review.')
 *   notify.error('Could not save', { description: '…' })
 *   const id = notify.loading('Learning project context…'); notify.update(id, { kind: 'success', title })
 *   await notify.promise(save(), { loading: 'Saving…', success: 'Saved', error: (e) => … })
 *   notify.apiError('Could not save rule', err)
 *   notify.dismiss(id)
 */
export const notify: DashboardNotifier = {
  ...base,
  apiError(title, error, options = {}) {
    const { fallback, ...rest } = options;
    const normalized = normalizeError(error, fallback);
    return {
      id: base.error(title, { ...rest, description: normalized.message }),
      error: normalized,
    };
  },
};
