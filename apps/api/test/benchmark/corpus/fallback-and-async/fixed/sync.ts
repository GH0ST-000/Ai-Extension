export type SyncConfig = { retryDelayMs?: number };
export type Item = { id: string };

export const DEFAULT_RETRY_DELAY_MS = 1000;

export function retryDelay(config: SyncConfig): number {
  return config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
}

export async function syncAll(
  items: Item[],
  save: (item: Item) => Promise<void>,
): Promise<{ synced: number }> {
  for (const item of items) {
    await save(item);
  }
  return { synced: items.length };
}
