import type { SaleDto, SaleItemDto } from '@pharmacy/shared';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { formatDateTime } from '@/lib/format';
import { formatMoney, toPaisa } from '@/lib/money';
import { cn } from '@/lib/utils';
import { PAYMENT_LABELS } from './payments';

/** Header and footer lines, set per pharmacy in the web app's .env (VITE_ variables are public). */
export const receiptConfig = {
  name: (import.meta.env.VITE_PHARMACY_NAME as string | undefined) || 'Pharmacy',
  address: (import.meta.env.VITE_PHARMACY_ADDRESS as string | undefined) || '',
  phone: (import.meta.env.VITE_PHARMACY_PHONE as string | undefined) || '',
  footer:
    (import.meta.env.VITE_RECEIPT_FOOTER as string | undefined) ||
    'Thank you. Please keep this receipt for returns.',
};

/** Money without the "Rs" prefix, for receipt columns. */
export const amount = (value: string | bigint) => formatMoney(value).replace(/^Rs /, '');
const isZero = (value: string) => toPaisa(value) === 0n;

/** "2027-06-30" → "06/27": what fits on a receipt line. */
const shortExpiry = (date: string) => `${date.slice(5, 7)}/${date.slice(2, 4)}`;

/** Consecutive sale lines of one medicine (FEFO split it across batches) print under one name. */
function groupByMedicine(items: SaleItemDto[]) {
  const groups: { name: string; unit: string; lines: SaleItemDto[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.lines[0]!.medicine.id === item.medicine.id) last.lines.push(item);
    else groups.push({ name: item.medicine.name, unit: item.medicine.unit, lines: [item] });
  }
  return groups;
}

export function Row({ left, right, strong }: { left: string; right: string; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-2', strong && 'font-bold')}>
      <span className="min-w-0">{left}</span>
      <span className="shrink-0 tabular-nums">{right}</span>
    </div>
  );
}

export const Rule = () => <div className="my-1.5 border-t border-dashed border-black" />;

/**
 * An 80mm thermal receipt for a saved sale. Everything on it comes from the
 * server's record of the sale, never from the cart, so it shows exactly what
 * was charged. A `provisional` receipt is for a sale made offline: built on
 * this device, numbered with its offline reference, batches as predicted.
 */
export function Receipt({ sale, provisional = false }: { sale: SaleDto; provisional?: boolean }) {
  const units = sale.items.reduce((sum, i) => sum + i.quantity, 0);
  return (
    <div className="receipt font-mono text-[12px] leading-snug text-black">
      <div className="text-center">
        <p className="text-[15px] font-bold">{receiptConfig.name}</p>
        {receiptConfig.address && <p>{receiptConfig.address}</p>}
        {receiptConfig.phone && <p>Tel: {receiptConfig.phone}</p>}
      </div>
      <Rule />
      <Row left="Receipt" right={sale.receiptNumber} strong />
      <Row left={formatDateTime(sale.soldAt)} right={sale.cashier.fullName} />
      {sale.status !== 'COMPLETED' && (
        <p className="text-center font-bold">*** {sale.status} ***</p>
      )}
      {provisional && (
        <p className="text-center text-[11px]">
          OFFLINE SALE: final receipt number assigned when synced
        </p>
      )}
      <Rule />

      {groupByMedicine(sale.items).map((group) => (
        <div key={group.lines[0]!.id} className="mb-1">
          <p className="font-bold break-words">{group.name}</p>
          {group.lines.map((line) => (
            <div key={line.id} className="pl-2">
              <Row
                left={`${line.quantity} × ${amount(line.unitPrice)}`}
                // Before discount; the discount is its own line below.
                right={amount((toPaisa(line.unitPrice) ?? 0n) * BigInt(line.quantity))}
              />
              <p className="text-[11px]">
                Batch {line.batch.batchNumber} · Exp {shortExpiry(line.batch.expiryDate)}
              </p>
              {!isZero(line.discount) && (
                <Row left="  Discount" right={`-${amount(line.discount)}`} />
              )}
            </div>
          ))}
        </div>
      ))}

      <Rule />
      <Row
        left={`Subtotal (${units} ${units === 1 ? 'item' : 'items'})`}
        right={amount(sale.subtotal)}
      />
      {!isZero(sale.discountTotal) && (
        <Row left="Discount" right={`-${amount(sale.discountTotal)}`} />
      )}
      <div className="my-1 text-[15px]">
        <Row left="TOTAL" right={formatMoney(sale.grandTotal)} strong />
      </div>
      {sale.payments.map((p) => (
        <Row
          key={p.id}
          left={`${PAYMENT_LABELS[p.method]}${p.reference ? ` (${p.reference})` : ''}`}
          right={amount(p.tendered ?? p.amount)}
        />
      ))}
      {!isZero(sale.changeDue) && <Row left="Change" right={amount(sale.changeDue)} strong />}
      <Rule />
      <p className="text-center">{receiptConfig.footer}</p>
    </div>
  );
}

/**
 * Mounts a slip where print CSS can find it. While this is mounted, printing
 * the page prints only the slip (see .receipt-print in index.css).
 */
export function PrintArea({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="receipt-print" aria-hidden>
      {children}
    </div>,
    document.body,
  );
}

export function ReceiptPrintArea({ sale, provisional }: { sale: SaleDto; provisional?: boolean }) {
  return (
    <PrintArea>
      <Receipt sale={sale} provisional={provisional} />
    </PrintArea>
  );
}
