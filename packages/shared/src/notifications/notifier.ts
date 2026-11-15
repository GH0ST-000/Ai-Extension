import type {
  NotificationKind,
  NotificationMessage,
  NotificationOptions,
  NotificationStore,
  Notifier,
  NotifyPromiseMessages,
} from './types';

function toOptions(description?: string | NotificationOptions): NotificationOptions {
  if (description === undefined) return {};
  return typeof description === 'string' ? { description } : description;
}

function toMessage(message: NotificationMessage): { title: string } & NotificationOptions {
  return typeof message === 'string' ? { title: message } : message;
}

/** The `notify` API bound to a store. One store + notifier per app (see docs/notifications.md). */
export function createNotifier(store: NotificationStore): Notifier {
  const show =
    (kind: NotificationKind) =>
    (title: string, description?: string | NotificationOptions): string =>
      store.show(kind, title, toOptions(description));

  return {
    success: show('success'),
    error: show('error'),
    warning: show('warning'),
    info: show('info'),
    loading: show('loading'),
    update: (id, patch) => store.update(id, patch),
    dismiss: (id) => store.dismiss(id),

    async promise<T>(
      operation: Promise<T> | (() => Promise<T>),
      messages: NotifyPromiseMessages<T>,
    ): Promise<T> {
      const loading = toMessage(messages.loading);
      const { title: loadingTitle, ...loadingOptions } = loading;
      // Each operation gets its own loading notification (never merged with another run).
      const id = store.show('loading', loadingTitle, { dedupeKey: null, ...loadingOptions });
      const settle = (kind: 'success' | 'error', message: NotificationMessage) => {
        const { title, description, duration } = toMessage(message);
        const patch = {
          kind,
          title,
          description: description ?? null,
          ...(duration !== undefined ? { duration } : {}),
        };
        // If the loading toast was dismissed meanwhile, the outcome is still announced.
        if (!store.update(id, patch)) store.show(kind, title, { description, duration });
      };
      try {
        const result = await (typeof operation === 'function' ? operation() : operation);
        settle(
          'success',
          typeof messages.success === 'function' ? messages.success(result) : messages.success,
        );
        return result;
      } catch (error) {
        const message =
          typeof messages.error === 'function' ? messages.error(error) : messages.error;
        if (message === null) store.dismiss(id);
        else settle('error', message);
        throw error;
      }
    },
  };
}

/** ARIA role for a notification: errors interrupt (alert), everything else is polite (status). */
export function notificationAriaRole(kind: NotificationKind): 'alert' | 'status' {
  return kind === 'error' ? 'alert' : 'status';
}

export function notificationAriaLive(kind: NotificationKind): 'assertive' | 'polite' {
  return kind === 'error' ? 'assertive' : 'polite';
}
