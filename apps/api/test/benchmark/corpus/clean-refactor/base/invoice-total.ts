export type LineItem = { unitPrice: number; quantity: number };

export function invoiceTotal(items: LineItem[]): number {
  let total = 0;
  for (const item of items) {
    total += Math.round(item.unitPrice * item.quantity * 100) / 100;
  }
  return Math.round(total * 100) / 100;
}
