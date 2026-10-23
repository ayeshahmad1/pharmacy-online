import { createBrowserRouter } from 'react-router';
import { AppLayout } from '@/components/layout/app-layout';
import { LoginPage } from '@/features/auth/login-page';
import { HomeRedirect, RequireAuth, RequireRole } from '@/features/auth/route-guards';
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
              { path: 'billing', element: <PlaceholderPage title="Billing" session={9} /> },
              { path: 'sales', element: <PlaceholderPage title="Sales" /> },
              { path: 'returns', element: <PlaceholderPage title="Returns" /> },
            ],
          },
          {
            element: <RequireRole roles={STAFF_ROLES} />,
            children: [
              { path: 'dashboard', element: <PlaceholderPage title="Dashboard" session={11} /> },
              { path: 'medicines', element: <PlaceholderPage title="Medicines" session={8} /> },
              { path: 'inventory', element: <PlaceholderPage title="Inventory" session={8} /> },
              { path: 'suppliers', element: <PlaceholderPage title="Suppliers" session={8} /> },
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
