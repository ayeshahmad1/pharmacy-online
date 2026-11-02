import { createBrowserRouter } from 'react-router';
import { AppLayout } from '@/components/layout/app-layout';
import { AlertsPage } from '@/features/alerts/alerts-page';
import { LoginPage } from '@/features/auth/login-page';
import { HomeRedirect, RequireAuth, RequireRole } from '@/features/auth/route-guards';
import { BillingPage } from '@/features/billing/billing-page';
import { CategoriesPage } from '@/features/categories/categories-page';
import { InventoryPage } from '@/features/inventory/inventory-page';
import { ReceiveStockPage } from '@/features/inventory/receive-stock-page';
import { LegacyPage } from '@/features/legacy/legacy-page';
import { MedicineDetailPage } from '@/features/medicines/medicine-detail-page';
import { MedicinesPage } from '@/features/medicines/medicines-page';
import { OfflineSalesPage } from '@/features/offline-sales/offline-sales-page';
import { NewReturnPage } from '@/features/returns/new-return-page';
import { ReturnDetailPage } from '@/features/returns/return-detail-page';
import { ReturnsPage } from '@/features/returns/returns-page';
import { SaleDetailPage } from '@/features/sales/sale-detail-page';
import { SalesPage } from '@/features/sales/sales-page';
import { SuppliersPage } from '@/features/suppliers/suppliers-page';
import { UsersPage } from '@/features/users/users-page';
import { ADMIN_ONLY, ALL_ROLES, STAFF_ROLES } from '@/lib/navigation';
import { NotFoundPage } from '@/pages/not-found-page';

// Route roles must match the `roles` of the matching item in lib/navigation.ts.
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <HomeRedirect /> },
          {
            element: <RequireRole roles={ALL_ROLES} />,
            children: [
              { path: 'billing', element: <BillingPage /> },
              { path: 'sales', element: <SalesPage /> },
              { path: 'sales/:id', element: <SaleDetailPage /> },
              { path: 'returns', element: <ReturnsPage /> },
              { path: 'returns/new', element: <NewReturnPage /> },
              { path: 'returns/:id', element: <ReturnDetailPage /> },
              { path: 'offline-sales', element: <OfflineSalesPage /> },
              { path: 'alerts', element: <AlertsPage /> },
            ],
          },
          {
            element: <RequireRole roles={STAFF_ROLES} />,
            children: [
              // Charts are code-split: billing devices never download them.
              {
                path: 'dashboard',
                lazy: async () => ({
                  Component: (await import('@/features/dashboard/dashboard-page')).DashboardPage,
                }),
              },
              { path: 'medicines', element: <MedicinesPage /> },
              { path: 'medicines/:id', element: <MedicineDetailPage /> },
              { path: 'categories', element: <CategoriesPage /> },
              { path: 'inventory', element: <InventoryPage /> },
              { path: 'inventory/receive', element: <ReceiveStockPage /> },
              { path: 'suppliers', element: <SuppliersPage /> },
              { path: 'old-records', element: <LegacyPage /> },
              {
                path: 'reports',
                lazy: async () => ({
                  Component: (await import('@/features/reports/reports-page')).ReportsPage,
                }),
              },
            ],
          },
          {
            element: <RequireRole roles={ADMIN_ONLY} />,
            children: [{ path: 'users', element: <UsersPage /> }],
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
