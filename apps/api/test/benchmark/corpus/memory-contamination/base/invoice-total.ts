export type LineItem = { unitPrice: number; quantity: number };

export function lineTotal(item: LineItem): number {
  return Math.round(item.unitPrice * item.quantity * 100) / 100;
}

export function invoiceTotal(items: LineItem[]): number {
  const sum = items.reduce((acc, item) => acc + lineTotal(item), 0);
  return Math.round(sum * 100) / 100;
}
