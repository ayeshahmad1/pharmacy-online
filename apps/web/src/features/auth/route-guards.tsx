import type { RoleCode } from '@pharmacy/shared';
import { Navigate, Outlet, useLocation } from 'react-router';
import { SplashScreen } from '@/components/splash-screen';
import { homePathFor } from '@/lib/navigation';
import { ForbiddenPage } from '@/pages/forbidden-page';
import { useAuth, useCurrentUser } from './auth-context';

/** Renders child routes only for a signed-in user; otherwise sends them to /login. */
export function RequireAuth() {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === 'loading') return <SplashScreen />;
  if (auth.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

/**
 * Renders child routes only for the given roles. This is a convenience for the
 * user; the API enforces the same rules on every request.
 */
export function RequireRole({ roles }: { roles: readonly RoleCode[] }) {
  const user = useCurrentUser();
  return roles.includes(user.role) ? <Outlet /> : <ForbiddenPage />;
}

export function HomeRedirect() {
  const user = useCurrentUser();
  return <Navigate to={homePathFor(user.role)} replace />;
}
