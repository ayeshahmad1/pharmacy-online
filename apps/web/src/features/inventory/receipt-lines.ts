import type { MedicineDto } from '@pharmacy/shared';
import { intInput } from '@/lib/form';
import { formatMoney, lineTotal, toPaisa } from '@/lib/money';
import { CRITICAL_EXPIRY_DAYS, daysUntil } from '@/lib/stock-status';

/** One line of a delivery as typed: every field is still form text. */
export type ReceiptLine = {
  key: string;
  medicine: MedicineDto | null;
  batchNumber: string;
  expiryDate: string;
  costPrice: string;
  quantity: string;
};

export function emptyLine(medicine: MedicineDto | null = null): ReceiptLine {
  return {
    key: crypto.randomUUID(),
    medicine,
    batchNumber: '',
    expiryDate: '',
    costPrice: '',
    quantity: '',
  };
}

/** The request body shape, before the shared schema checks it. */
export function toReceiptInput(supplierId: string, invoiceNumber: string, lines: ReceiptLine[]) {
  return {
    supplierId,
    invoiceNumber,
    items: lines.map((line) => ({
      medicineId: line.medicine?.id ?? '',
      batchNumber: line.batchNumber,
      expiryDate: line.expiryDate,
      costPrice: line.costPrice,
      quantity: intInput(line.quantity),
    })),
  };
}

export function lineCost(line: ReceiptLine): bigint | null {
  const quantity = intInput(line.quantity);
  return typeof quantity === 'number' && quantity > 0 ? lineTotal(line.costPrice, quantity) : null;
}

/** Units and cost over the lines that are complete enough to count. */
export function receiptTotals(lines: ReceiptLine[]) {
  let units = 0;
  let cost = 0n;
  for (const line of lines) {
    const quantity = intInput(line.quantity);
    if (typeof quantity === 'number' && quantity > 0) units += quantity;
    cost += lineCost(line) ?? 0n;
  }
  return { units, cost };
}

/**
 * Problems the schema cannot see because they depend on today's date. The
 * API checks expiry again in the pharmacy's timezone; this catches it early.
 */
export function lineDateErrors(lines: ReceiptLine[], today = new Date()): Record<string, string> {
  const errors: Record<string, string> = {};
  lines.forEach((line, i) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(line.expiryDate) && daysUntil(line.expiryDate, today) <= 0) {
      errors[`items.${i}.expiryDate`] = 'Already expired; expired stock cannot be received';
    }
  });
  return errors;
}

/** Things worth a second look that do not block saving. */
export function lineWarnings(line: ReceiptLine, today = new Date()): string[] {
  const warnings: string[] = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(line.expiryDate)) {
    const days = daysUntil(line.expiryDate, today);
    if (days > 0 && days <= CRITICAL_EXPIRY_DAYS) {
      warnings.push(`Short expiry: only ${days} ${days === 1 ? 'day' : 'days'} left`);
    }
  }
  const cost = toPaisa(line.costPrice);
  const price = line.medicine && toPaisa(line.medicine.sellingPrice);
  if (cost !== null && price !== null && price !== undefined && cost > price) {
    warnings.push(
      `Cost is above the selling price (${formatMoney(line.medicine!.sellingPrice)}); check the price or the medicine`,
    );
  }
  return warnings;
}

/** "YYYY-MM-DD" for tomorrow in the browser's calendar: the earliest receivable expiry. */
export function tomorrow(today = new Date()): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
