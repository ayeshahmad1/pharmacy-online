import type {
  CashClosingQuery,
  DeadStockQuery,
  ExpiryReportQuery,
  LowStockReportQuery,
  MedicineReportQuery,
  ReportRangeQuery,
  SalesReportQuery,
  SupplierPurchasesQuery,
} from '@pharmacy/shared';
import type { Request, RequestHandler } from 'express';
import { sendCsv, toCsv } from '../../lib/csv';
import * as csv from './reports.csv';
import * as service from './reports.service';

// Routes run authenticate + requireRole + validate first, so the query is
// already parsed. `format=csv` sends the whole report (every page) as a file.
const query = <T>(req: Request) => req.query as unknown as T;
const allRows = { page: 1, pageSize: service.CSV_MAX_ROWS };

export const dashboard: RequestHandler = async (_req, res) => {
  res.set('Cache-Control', 'no-store').json(await service.dashboard());
};

export const sales: RequestHandler = async (req, res) => {
  const q = query<SalesReportQuery>(req);
  const report = await service.salesReport(q);
  if (q.format === 'csv') {
    const name = `sales-by-${report.groupBy}-${report.from}-to-${report.to}.csv`;
    return sendCsv(res, name, toCsv(csv.salesColumns, report.periods));
  }
  res.json(report);
};

export const medicines: RequestHandler = async (req, res) => {
  const q = query<MedicineReportQuery>(req);
  if (q.format === 'csv') {
    const report = await service.medicineReport({ ...q, ...allRows });
    const name = `medicine-sales-${report.from}-to-${report.to}.csv`;
    return sendCsv(res, name, toCsv(csv.medicineSalesColumns, report.items));
  }
  res.json(await service.medicineReport(q));
};

export const deadStock: RequestHandler = async (req, res) => {
  const q = query<DeadStockQuery>(req);
  if (q.format === 'csv') {
    const report = await service.deadStockReport({ ...q, ...allRows });
    return sendCsv(
      res,
      `dead-stock-${report.days}-days.csv`,
      toCsv(csv.deadStockColumns, report.items),
    );
  }
  res.json(await service.deadStockReport(q));
};

export const expiry: RequestHandler = async (req, res) => {
  const q = query<ExpiryReportQuery>(req);
  if (q.format === 'csv') {
    const report = await service.expiryReport({ ...q, ...allRows });
    return sendCsv(res, `expiry-until-${report.until}.csv`, toCsv(csv.expiryColumns, report.items));
  }
  res.json(await service.expiryReport(q));
};

export const lowStock: RequestHandler = async (req, res) => {
  const q = query<LowStockReportQuery>(req);
  if (q.format === 'csv') {
    const report = await service.lowStockReport({ ...q, ...allRows });
    return sendCsv(res, 'low-stock.csv', toCsv(csv.lowStockColumns, report.items));
  }
  res.json(await service.lowStockReport(q));
};

export const supplierPurchases: RequestHandler = async (req, res) => {
  const q = query<SupplierPurchasesQuery>(req);
  const report = await service.supplierPurchasesReport(q);
  if (q.format === 'csv') {
    const range = `${report.from}-to-${report.to}`;
    return report.lines
      ? sendCsv(res, `purchases-${range}.csv`, toCsv(csv.supplierLineColumns, report.lines))
      : sendCsv(
          res,
          `supplier-purchases-${range}.csv`,
          toCsv(csv.supplierColumns, report.suppliers),
        );
  }
  res.json(report);
};

export const cashiers: RequestHandler = async (req, res) => {
  const q = query<ReportRangeQuery>(req);
  const report = await service.cashierReport(q);
  if (q.format === 'csv') {
    const name = `cashier-sales-${report.from}-to-${report.to}.csv`;
    return sendCsv(res, name, toCsv(csv.cashierColumns, report.cashiers));
  }
  res.json(report);
};

export const cashClosing: RequestHandler = async (req, res) => {
  const q = query<CashClosingQuery>(req);
  const report = await service.cashClosingReport(q);
  if (q.format === 'csv') {
    const rows = csv.cashClosingRows(report);
    return sendCsv(res, `cash-closing-${report.date}.csv`, toCsv(csv.cashClosingColumns, rows));
  }
  res.set('Cache-Control', 'no-store').json(report);
};
