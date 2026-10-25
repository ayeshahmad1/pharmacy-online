// Completing a sale without the server, as pure functions (offline-sale.test.ts).
// Nobody can check the sale until it syncs, so the counter enforces here what
// the API would: only unexpired stock that is still on the shelf by this
// device's count (rules 2-3), and the cashier discount cap. Prices are the
// cart's (the newest the counter saw); the API refuses the sale at sync if
// the catalogue then disagrees. The request is built once and queued
// unchanged; the receipt printed now is provisional.

import type {
  CreateSaleBody,
  OfflineBatchDto,
  PaymentDto,
  PaymentInput,
  SaleDto,
  SaleItemDto,
  SellableMedicineDto,
  UserDto,
} from '@pharmacy/shared';
import { allocate, paisaToAmount, percentOf, sumPaisa, toPaisa } from '@/lib/money';
import { predictFefo } from '@/offline/catalogue';
import { offlineRef } from '@/offline/sale-queue';
import { toSaleBody, type Cart, type CartTotals } from './cart';
import { shortageMessage, type SaleProblem } from './sale-errors';

const emptyProblem = (message: string): SaleProblem => ({
  message,
  lines: {},
  unavailable: [],
  stockUpdates: [],
  billDiscount: null,
  payment: null,
  retryable: false,
  alreadySaved: false,
});

export type OfflineCheck = {
  /** Current local view of each cart medicine; missing = not in the cached catalogue. */
  stock: Map<string, SellableMedicineDto>;
  /** Null when this device has no catalogue saved. */
  cashierMaxDiscountPercent: number | null;
  role: UserDto['role'];
};

/**
 * Why this cart can't be sold offline, in the shape the billing screen
 * already shows for API errors, or null if it can.
 */
export function checkOfflineSale(
  cart: Cart,
  totals: CartTotals,
  check: OfflineCheck,
): SaleProblem | null {
  if (check.cashierMaxDiscountPercent === null) {
    return emptyProblem(
      'This device has no medicine list saved yet, so it cannot sell offline. Reconnect to the server once to download it.',
    );
  }
  const problem = emptyProblem('');
  for (const line of cart.lines) {
    const now = check.stock.get(line.medicine.id);
    if (!now) {
      problem.lines[line.medicine.id] = 'Not in the medicine list saved on this device';
      problem.unavailable.push(line.medicine.id);
      continue;
    }
    if (line.quantity > now.sellableQuantity) {
      problem.lines[line.medicine.id] = shortageMessage({
        available: now.sellableQuantity,
        expiredQuantity: now.expiredQuantity,
        unit: now.unit,
      });
      problem.stockUpdates.push({
        medicineId: now.id,
        available: now.sellableQuantity,
        expired: now.expiredQuantity,
      });
      if (now.sellableQuantity <= 0) problem.unavailable.push(now.id);
    }
  }
  if (Object.keys(problem.lines).length > 0) {
    problem.message =
      'Offline: some items can’t be sold from the stock this device knows about. Fix the marked lines.';
    return problem;
  }

  if (check.role === 'CASHIER') {
    const maxPercent = check.cashierMaxDiscountPercent;
    const cap = percentOf(totals.subtotal, String(maxPercent));
    if (totals.discountTotal > cap) {
      const message = `Cashiers can give at most ${maxPercent}% discount (Rs ${paisaToAmount(cap)} on this bill); ask a pharmacist`;
      return { ...emptyProblem(message), billDiscount: message };
    }
  }
  return null;
}

/**
 * The payment rows the API will record, the way its settlePayments does:
 * card and wallet as given, cash reduced by the change, which it hands back.
 */
export function settleOffline(
  grandTotal: bigint,
  payments: PaymentInput[],
): { payments: Omit<PaymentDto, 'id'>[]; change: bigint; tendered: bigint } {
  const amounts = payments.map((p) => toPaisa(p.amount) ?? 0n);
  const tendered = sumPaisa(amounts);
  const change = tendered > grandTotal ? tendered - grandTotal : 0n;
  return {
    change,
    tendered,
    payments: payments.map((p, i) => ({
      method: p.method,
      amount: paisaToAmount(p.method === 'CASH' ? amounts[i]! - change : amounts[i]!),
      tendered: p.method === 'CASH' && change > 0n ? paisaToAmount(amounts[i]!) : null,
      reference: p.reference ?? null,
    })),
  };
}

export type OfflineSale = { body: CreateSaleBody; receipt: SaleDto };

/**
 * The request to queue and the provisional receipt for it. Batches on the
 * receipt are a prediction (what FEFO would take from this device's stock
 * count); the API picks them for real when the sale syncs.
 */
export function buildOfflineSale(opts: {
  cart: Cart;
  totals: CartTotals;
  payments: PaymentInput[];
  user: Pick<UserDto, 'id' | 'username' | 'fullName'>;
  /** Projected batches of each cart medicine. */
  batches: Map<string, OfflineBatchDto[]>;
  today: string;
  now: Date;
}): OfflineSale {
  const { cart, totals, payments, now } = opts;
  const soldAt = now.toISOString();
  const body: CreateSaleBody = {
    ...toSaleBody(cart, payments),
    offline: { soldAt, expectedTotal: paisaToAmount(totals.grandTotal) },
  };

  const items: SaleItemDto[] = cart.lines.flatMap((line, index) => {
    const priced = totals.lines[index]!;
    const unitPrice = toPaisa(line.medicine.sellingPrice) ?? 0n;
    const picks = predictFefo(
      opts.batches.get(line.medicine.id) ?? [],
      line.quantity,
      opts.today,
    ) ?? [
      {
        batch: { id: '', batchNumber: '—', expiryDate: '', quantity: line.quantity },
        quantity: line.quantity,
      },
    ];
    // The line's discount split by quantity, as the API's splitLine does.
    const shares = allocate(
      priced.lineDiscount + priced.billShare,
      picks.map((p) => BigInt(p.quantity)),
    );
    return picks.map((pick, i) => ({
      id: `${cart.idempotencyKey}:${index}:${i}`,
      medicine: {
        id: line.medicine.id,
        name: line.medicine.name,
        genericName: line.medicine.genericName,
        unit: line.medicine.unit,
      },
      batch: {
        id: pick.batch.id,
        batchNumber: pick.batch.batchNumber,
        expiryDate: pick.batch.expiryDate,
      },
      quantity: pick.quantity,
      unitPrice: paisaToAmount(unitPrice),
      discount: paisaToAmount(shares[i]!),
      tax: '0.00',
      lineTotal: paisaToAmount(unitPrice * BigInt(pick.quantity) - shares[i]!),
    }));
  });

  const settlement = settleOffline(totals.grandTotal, payments);
  const cashier = { id: opts.user.id, username: opts.user.username, fullName: opts.user.fullName };
  const receipt: SaleDto = {
    id: cart.idempotencyKey,
    receiptNumber: offlineRef(cart.idempotencyKey),
    idempotencyKey: cart.idempotencyKey,
    status: 'COMPLETED',
    soldAt,
    cashier,
    subtotal: paisaToAmount(totals.subtotal),
    discountTotal: paisaToAmount(totals.discountTotal),
    taxTotal: '0.00',
    grandTotal: paisaToAmount(totals.grandTotal),
    changeDue: paisaToAmount(settlement.change),
    amountTendered: paisaToAmount(totals.grandTotal + settlement.change),
    notes: body.notes ?? null,
    items,
    payments: settlement.payments.map((p, i) => ({ ...p, id: `${cart.idempotencyKey}:pay:${i}` })),
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
  };
  return { body, receipt };
}
