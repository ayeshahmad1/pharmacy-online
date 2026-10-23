import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import * as client from '@/lib/api';
import { AuthContext, type AuthState } from './auth-context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null });

  useEffect(() => {
    const unsubscribe = client.onSessionEvent((event) => {
      if (event.type === 'refreshed') {
        // The server re-reads role and status on refresh; keep the UI in step.
        setState({ status: 'authenticated', user: event.auth.user });
        return;
      }
      setState({ status: 'anonymous', user: null });
      queryClient.clear();
      if (event.reason === 'expired') toast.info('Your session has expired. Please log in again.');
    });

    // The access token is memory-only, so a reload starts without one: try the
    // refresh cookie to restore the session.
    client.refreshSession().catch((err: unknown) => {
      setState({ status: 'anonymous', user: null });
      if (err instanceof client.ApiError && err.code === 'NETWORK_ERROR') {
        toast.error(err.message);
      }
    });

    return unsubscribe;
  }, [queryClient]);

  const login = useCallback(async (username: string, password: string) => {
    const { user } = await client.login(username, password);
    setState({ status: 'authenticated', user });
    return user;
  }, []);

  const logout = useCallback(() => client.logout(), []);

  const value = useMemo(() => ({ ...state, login, logout }), [state, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
