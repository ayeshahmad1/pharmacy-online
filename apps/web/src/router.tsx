import { createBrowserRouter } from 'react-router';
import { AppLayout } from '@/components/layout/app-layout';
import { LoginPage } from '@/features/auth/login-page';
import { HomeRedirect, RequireAuth, RequireRole } from '@/features/auth/route-guards';
import { BillingPage } from '@/features/billing/billing-page';
import { CategoriesPage } from '@/features/categories/categories-page';
import { InventoryPage } from '@/features/inventory/inventory-page';
import { ReceiveStockPage } from '@/features/inventory/receive-stock-page';
import { MedicineDetailPage } from '@/features/medicines/medicine-detail-page';
import { MedicinesPage } from '@/features/medicines/medicines-page';
import { OfflineSalesPage } from '@/features/offline-sales/offline-sales-page';
import { SuppliersPage } from '@/features/suppliers/suppliers-page';
import { ADMIN_ONLY, ALL_ROLES, STAFF_ROLES } from '@/lib/navigation';
import { NotFoundPage } from '@/pages/not-found-page';
import { PlaceholderPage } from '@/pages/placeholder-page';

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
              { path: 'sales', element: <PlaceholderPage title="Sales" /> },
              { path: 'returns', element: <PlaceholderPage title="Returns" /> },
              { path: 'offline-sales', element: <OfflineSalesPage /> },
            ],
          },
          {
            element: <RequireRole roles={STAFF_ROLES} />,
            children: [
              { path: 'dashboard', element: <PlaceholderPage title="Dashboard" session={11} /> },
              { path: 'medicines', element: <MedicinesPage /> },
              { path: 'medicines/:id', element: <MedicineDetailPage /> },
              { path: 'categories', element: <CategoriesPage /> },
              { path: 'inventory', element: <InventoryPage /> },
              { path: 'inventory/receive', element: <ReceiveStockPage /> },
              { path: 'suppliers', element: <SuppliersPage /> },
              { path: 'reports', element: <PlaceholderPage title="Reports" session={11} /> },
            ],
          },
          {
            element: <RequireRole roles={ADMIN_ONLY} />,
            children: [{ path: 'users', element: <PlaceholderPage title="Users" /> }],
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
