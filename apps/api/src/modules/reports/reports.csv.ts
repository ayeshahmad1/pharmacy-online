// Spreadsheet columns for each report's CSV export. Money and percentages
// are the exact strings from the report; dates are business days or ISO
// timestamps.

import type {
  CashClosingPersonDto,
  CashClosingReportDto,
  CashierSalesRowDto,
  DeadStockDto,
  ExpiryRowDto,
  LowStockRowDto,
  MedicineSalesDto,
  SalesPeriodDto,
  SupplierPurchaseLineDto,
  SupplierPurchasesRowDto,
} from '@pharmacy/shared';
import type { CsvColumn } from '../../lib/csv';

const medicineColumns = <
  T extends { medicine: MedicineSalesDto['medicine'] },
>(): CsvColumn<T>[] => [
  { header: 'Medicine', value: (r) => r.medicine.name, text: true },
  { header: 'Generic name', value: (r) => r.medicine.genericName, text: true },
  { header: 'Category', value: (r) => r.medicine.category, text: true },
  { header: 'Unit', value: (r) => r.medicine.unit, text: true },
];

export const salesColumns: CsvColumn<SalesPeriodDto>[] = [
  { header: 'Period start', value: (r) => r.period },
  { header: 'Sales', value: (r) => r.saleCount },
  { header: 'Gross sales', value: (r) => r.grossSales },
  { header: 'Discounts', value: (r) => r.discounts },
  { header: 'Net sales', value: (r) => r.netSales },
  { header: 'Refunds', value: (r) => r.refunds },
  { header: 'Revenue', value: (r) => r.revenue },
  { header: 'Cost', value: (r) => r.cost },
  { header: 'Gross profit', value: (r) => r.grossProfit },
  { header: 'Margin %', value: (r) => r.marginPercent },
  { header: 'Average bill', value: (r) => r.averageBill },
];

export const medicineSalesColumns: CsvColumn<MedicineSalesDto>[] = [
  ...medicineColumns<MedicineSalesDto>(),
  { header: 'Units sold', value: (r) => r.unitsSold },
  { header: 'Units returned', value: (r) => r.unitsReturned },
  { header: 'Net units', value: (r) => r.netUnits },
  { header: 'Net sales', value: (r) => r.netSales },
  { header: 'Refunds', value: (r) => r.refunds },
  { header: 'Revenue', value: (r) => r.revenue },
  { header: 'Cost', value: (r) => r.cost },
  { header: 'Gross profit', value: (r) => r.grossProfit },
  { header: 'Margin %', value: (r) => r.marginPercent },
];

export const deadStockColumns: CsvColumn<DeadStockDto>[] = [
  ...medicineColumns<DeadStockDto>(),
  { header: 'Sellable stock', value: (r) => r.sellableQuantity },
  { header: 'Selling price', value: (r) => r.medicine.sellingPrice },
  { header: 'Cost value', value: (r) => r.costValue },
  { header: 'Retail value', value: (r) => r.retailValue },
  { header: 'Last sold at', value: (r) => r.lastSoldAt ?? 'Never' },
  { header: 'Oldest stock received at', value: (r) => r.oldestStockReceivedAt },
];

export const expiryColumns: CsvColumn<ExpiryRowDto>[] = [
  ...medicineColumns<ExpiryRowDto>(),
  { header: 'Batch', value: (r) => r.batch.batchNumber, text: true },
  { header: 'Supplier', value: (r) => r.supplier.name, text: true },
  { header: 'Expiry date', value: (r) => r.batch.expiryDate },
  { header: 'Days to expiry', value: (r) => r.daysToExpiry },
  { header: 'Status', value: (r) => (r.isExpired ? 'EXPIRED' : r.bucket) },
  { header: 'Quantity', value: (r) => r.quantity },
  { header: 'Cost value', value: (r) => r.costValue },
  { header: 'Retail value', value: (r) => r.retailValue },
];

export const lowStockColumns: CsvColumn<LowStockRowDto>[] = [
  ...medicineColumns<LowStockRowDto>(),
  { header: 'Sellable stock', value: (r) => r.sellableQuantity },
  { header: 'Expired on shelf', value: (r) => r.expiredQuantity },
  { header: 'Reorder level', value: (r) => r.medicine.reorderLevel },
  { header: 'Short by', value: (r) => r.shortBy },
  { header: 'Sold last 30 days', value: (r) => r.soldLast30Days },
  { header: 'Days of cover', value: (r) => r.daysOfCover },
  { header: 'Last supplier', value: (r) => r.lastSupplier?.name, text: true },
  { header: 'Last cost price', value: (r) => r.lastCostPrice },
  { header: 'Last received at', value: (r) => r.lastReceivedAt },
];

export const supplierColumns: CsvColumn<SupplierPurchasesRowDto>[] = [
  { header: 'Supplier', value: (r) => r.supplier.name, text: true },
  { header: 'Batches', value: (r) => r.batches },
  { header: 'Medicines', value: (r) => r.medicines },
  { header: 'Units', value: (r) => r.units },
  { header: 'Purchase value', value: (r) => r.value },
  { header: 'Last received at', value: (r) => r.lastReceivedAt },
];

export const supplierLineColumns: CsvColumn<SupplierPurchaseLineDto>[] = [
  { header: 'Received at', value: (r) => r.receivedAt },
  ...medicineColumns<SupplierPurchaseLineDto>(),
  { header: 'Batch', value: (r) => r.batch.batchNumber, text: true },
  { header: 'Expiry date', value: (r) => r.batch.expiryDate },
  { header: 'Reference', value: (r) => r.reference, text: true },
  { header: 'Quantity', value: (r) => r.quantity },
  { header: 'Cost price', value: (r) => r.costPrice },
  { header: 'Value', value: (r) => r.value },
];

export const cashierColumns: CsvColumn<CashierSalesRowDto>[] = [
  { header: 'Cashier', value: (r) => r.cashier.fullName, text: true },
  { header: 'Username', value: (r) => r.cashier.username, text: true },
  { header: 'Sales', value: (r) => r.saleCount },
  { header: 'Units sold', value: (r) => r.unitsSold },
  { header: 'Gross sales', value: (r) => r.grossSales },
  { header: 'Discounts', value: (r) => r.discounts },
  { header: 'Net sales', value: (r) => r.netSales },
  { header: 'Refunds', value: (r) => r.refunds },
  { header: 'Revenue', value: (r) => r.revenue },
  { header: 'Average bill', value: (r) => r.averageBill },
  { header: 'Cash', value: (r) => r.payments.CASH },
  { header: 'Card', value: (r) => r.payments.CARD },
  { header: 'Mobile wallet', value: (r) => r.payments.MOBILE_WALLET },
  { header: 'Voided sales', value: (r) => r.voidedCount },
  { header: 'Voided total', value: (r) => r.voidedTotal },
];

/** One row per person plus a TOTAL row; the per-method columns are the drawer's net. */
export type CashClosingCsvRow = Pick<
  CashClosingPersonDto,
  'sales' | 'voids' | 'refunds' | 'net' | 'expectedCash'
> & { name: string; username: string };

export function cashClosingRows(report: CashClosingReportDto): CashClosingCsvRow[] {
  return [
    ...report.people.map((p) => ({ ...p, name: p.user.fullName, username: p.user.username })),
    { ...report, name: 'TOTAL', username: '' },
  ];
}

export const cashClosingColumns: CsvColumn<CashClosingCsvRow>[] = [
  { header: 'Person', value: (r) => r.name, text: true },
  { header: 'Username', value: (r) => r.username, text: true },
  { header: 'Sales', value: (r) => r.sales.count },
  { header: 'Sales cash', value: (r) => r.sales.byMethod.CASH },
  { header: 'Sales card', value: (r) => r.sales.byMethod.CARD },
  { header: 'Sales wallet', value: (r) => r.sales.byMethod.MOBILE_WALLET },
  { header: 'Voids', value: (r) => r.voids.count },
  { header: 'Voids cash', value: (r) => r.voids.byMethod.CASH },
  { header: 'Voids card', value: (r) => r.voids.byMethod.CARD },
  { header: 'Voids wallet', value: (r) => r.voids.byMethod.MOBILE_WALLET },
  { header: 'Refunds', value: (r) => r.refunds.count },
  { header: 'Refunds cash', value: (r) => r.refunds.byMethod.CASH },
  { header: 'Refunds card', value: (r) => r.refunds.byMethod.CARD },
  { header: 'Refunds wallet', value: (r) => r.refunds.byMethod.MOBILE_WALLET },
  { header: 'Net card', value: (r) => r.net.CARD },
  { header: 'Net wallet', value: (r) => r.net.MOBILE_WALLET },
  { header: 'Expected cash', value: (r) => r.expectedCash },
];
