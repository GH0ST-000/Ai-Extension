export type Where = Record<string, unknown>;

export type Table<T> = {
  findFirst(query: { where: Where }): Promise<T | null>;
  findUnique(query: { where: Where }): Promise<T | null>;
  findMany(query: { where: Where }): Promise<T[]>;
  count(query: { where: Where }): Promise<number>;
  create(query: { data: T }): Promise<T>;
  update(query: { where: Where; data: Partial<T> }): Promise<T | null>;
  delete(query: { where: Where }): Promise<void>;
};
