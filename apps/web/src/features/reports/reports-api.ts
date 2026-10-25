import type {
  CashClosingReportDto,
  CashierReportDto,
  DashboardDto,
  DeadStockReportDto,
  ExpiryReportDto,
  LowStockReportDto,
  MedicineReportDto,
  SalesReportDto,
  SupplierPurchasesReportDto,
} from '@pharmacy/shared';
import { api } from '@/lib/api';
import { saveFile } from '@/lib/download';

export type ReportQuery = Record<string, string | number | undefined>;

export const reportKeys = {
  all: ['reports'] as const,
  dashboard: ['reports', 'dashboard'] as const,
  report: (name: string, query: ReportQuery) => ['reports', name, query] as const,
};

const get =
  <T>(path: string) =>
  (query: ReportQuery, signal?: AbortSignal) =>
    api.get<T>(`/reports/${path}`, query, signal);

export const reportsApi = {
  dashboard: (signal?: AbortSignal) => api.get<DashboardDto>('/reports/dashboard', {}, signal),
  sales: get<SalesReportDto>('sales'),
  medicines: get<MedicineReportDto>('medicines'),
  deadStock: get<DeadStockReportDto>('dead-stock'),
  expiry: get<ExpiryReportDto>('expiry'),
  lowStock: get<LowStockReportDto>('low-stock'),
  supplierPurchases: get<SupplierPurchasesReportDto>('supplier-purchases'),
  cashiers: get<CashierReportDto>('cashiers'),
  cashClosing: get<CashClosingReportDto>('cash-closing'),
};

/** Downloads a report as CSV: every row, not just the page on screen. */
export async function downloadReport(path: string, query: ReportQuery) {
  const { page: _page, pageSize: _pageSize, ...filters } = query;
  const { blob, filename } = await api.download(`/reports/${path}`, { ...filters, format: 'csv' });
  saveFile(blob, filename);
}
