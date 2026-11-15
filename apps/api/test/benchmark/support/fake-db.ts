/**
 * Minimal in-memory table used by the corpus witness tests (ground-truth proofs). It
 * implements the same structural `Table<T>` interface the corpus code is written against,
 * with optional latency (to expose races) and injected write failures (to expose missing
 * transactions). Shallow `where` equality only — enough for the corpus queries.
 */
export type Where = Record<string, unknown>;

type Row = Record<string, unknown>;

/** Equality, or a comparison object `{ gt | gte | lt | lte: n }` (Prisma style). */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected !== null && typeof expected === 'object') {
      const v = row[key] as number;
      const c = expected as { gt?: number; gte?: number; lt?: number; lte?: number };
      return (
        (c.gt == null || v > c.gt) &&
        (c.gte == null || v >= c.gte) &&
        (c.lt == null || v < c.lt) &&
        (c.lte == null || v <= c.lte)
      );
    }
    return row[key] === expected;
  });
}

/** Plain values, or `{ increment | decrement: n }` applied atomically to the current value. */
function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object') {
      const op = value as { increment?: number; decrement?: number };
      row[key] = (row[key] as number) + (op.increment ?? 0) - (op.decrement ?? 0);
    } else {
      row[key] = value;
    }
  }
}

/** Error a unique constraint raises (Prisma's code for a unique violation). */
export class UniqueViolation extends Error {
  readonly code = 'P2002';
  constructor() {
    super('UNIQUE_VIOLATION');
  }
}

export type FakeTableOptions = {
  /** Milliseconds every operation waits before touching the rows (interleaves callers). */
  delayMs?: number;
  /** Throw on a write when this returns true (simulates a failed statement). */
  failWrite?: (op: 'create' | 'update' | 'delete', where: Where | undefined) => boolean;
  /** Columns that are unique together: a duplicate create throws `UniqueViolation`. */
  unique?: string[];
};

/** Undo actions recorded at the moment of each write (used by `fakeTransaction`). */
export type Journal = (() => void)[];

export function fakeTable<T extends object>(rows: T[], options: FakeTableOptions = {}) {
  const touch = (journal: Journal | undefined, hit: Row[]) =>
    journal?.push(
      ...hit.map((row) => {
        const before = { ...row };
        return () => Object.assign(row, before);
      }),
    );
  const all = () => rows as unknown as Row[];
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, options.delayMs ?? 0));
  const fail = (op: 'create' | 'update' | 'delete', where?: Where) => {
    if (options.failWrite?.(op, where)) throw new Error('WRITE_FAILED');
  };
  return {
    rows,
    async findFirst({ where }: { where: Where }): Promise<T | null> {
      await wait();
      return (all().find((r) => matches(r, where)) as T | undefined) ?? null;
    },
    async findUnique({ where }: { where: Where }): Promise<T | null> {
      await wait();
      return (all().find((r) => matches(r, where)) as T | undefined) ?? null;
    },
    async findMany({ where }: { where: Where }): Promise<T[]> {
      await wait();
      return all().filter((r) => matches(r, where)) as T[];
    },
    async count({ where }: { where: Where }): Promise<number> {
      await wait();
      return all().filter((r) => matches(r, where)).length;
    },
    async create({ data }: { data: T }, journal?: Journal): Promise<T> {
      await wait();
      fail('create');
      const key = options.unique;
      if (key && all().some((r) => key.every((k) => r[k] === (data as Row)[k]))) {
        throw new UniqueViolation();
      }
      rows.push(data);
      journal?.push(() => {
        const i = rows.indexOf(data);
        if (i >= 0) rows.splice(i, 1);
      });
      return data;
    },
    async update(
      { where, data }: { where: Where; data: Partial<T> },
      journal?: Journal,
    ): Promise<T | null> {
      await wait();
      fail('update', where);
      const row = all().find((r) => matches(r, where));
      if (!row) return null;
      touch(journal, [row]);
      apply(row, data as Row);
      return row as T;
    },
    /** Atomic conditional update: matching and writing happen in one step. */
    async updateMany(
      { where, data }: { where: Where; data: Row },
      journal?: Journal,
    ): Promise<{ count: number }> {
      await wait();
      fail('update', where);
      const hit = all().filter((r) => matches(r, where));
      touch(journal, hit);
      for (const row of hit) apply(row, data);
      return { count: hit.length };
    },
    async delete({ where }: { where: Where }, journal?: Journal): Promise<void> {
      await wait();
      fail('delete', where);
      const index = all().findIndex((r) => matches(r, where));
      if (index >= 0) {
        const [gone] = rows.splice(index, 1);
        journal?.push(() => rows.splice(index, 0, gone!));
      }
    },
  };
}

/** A per-key mutex like a database advisory lock. */
export function fakeLock() {
  const tails = new Map<string, Promise<unknown>>();
  return async <R>(key: string, fn: () => Promise<R>): Promise<R> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    tails.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  };
}

/**
 * A transaction with READ COMMITTED semantics for these tests: reads take no locks, so
 * concurrent transactions are NOT serialized and a read-then-write can interleave with another
 * transaction. It is atomic: on failure, only this transaction's own writes are undone.
 */
export function fakeTransaction<D extends Record<string, unknown>>(db: D) {
  type AnyTable = ReturnType<typeof fakeTable<Record<string, unknown>>>;
  const isTable = (t: unknown): t is AnyTable =>
    typeof t === 'object' && t !== null && Array.isArray((t as { rows?: unknown }).rows);
  return async <R>(fn: (tx: D) => Promise<R>): Promise<R> => {
    const journal: Journal = [];
    const wrap = (table: AnyTable): AnyTable => ({
      ...table,
      create: (q) => table.create(q, journal),
      update: (q) => table.update(q, journal),
      updateMany: (q) => table.updateMany(q, journal),
      delete: (q) => table.delete(q, journal),
    });
    const tx = Object.fromEntries(
      Object.entries(db).map(([k, v]) => [k, isTable(v) ? wrap(v) : v]),
    ) as D;
    try {
      return await fn(tx);
    } catch (error) {
      journal.reverse().forEach((undo) => undo());
      throw error;
    }
  };
}
