import type { UserDto } from '@pharmacy/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import * as client from '@/lib/api';
import { connectivity } from '@/lib/connectivity';
import { rememberedUser } from '@/offline/session';
import { AuthContext, type AuthState } from './auth-context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null });

  useEffect(() => {
    const unsubscribe = client.onSessionEvent((event) => {
      if (event.type === 'refreshed') {
        // The server re-reads role and status on refresh; keep the UI in step.
        setState({ status: 'authenticated', user: event.auth.user });
        void rememberedUser.save(event.auth.user);
        return;
      }
      void rememberedUser.forget();
      setState({ status: 'anonymous', user: null });
      queryClient.clear();
      if (event.reason === 'expired') toast.info('Your session has expired. Please log in again.');
    });

    // The access token is memory-only, so a reload starts without one: try the
    // refresh cookie to restore the session.
    client.refreshSession().catch(async (err: unknown) => {
      if (client.isUnreachable(err)) {
        // The counter must keep billing offline: carry on as the user who was
        // signed in here, until the server can confirm the session.
        const user = await rememberedUser.get().catch((): UserDto | null => null);
        if (user) {
          client.setSessionRestorable(true);
          setState({ status: 'authenticated', user, resumedOffline: true });
          toast.info('Working offline. Sales are kept on this device until the server is back.');
          return;
        }
      }
      setState({ status: 'anonymous', user: null });
      if (client.isUnreachable(err)) toast.error(client.errorMessage(err));
    });

    return unsubscribe;
  }, [queryClient]);

  const resumedOffline = state.status === 'authenticated' && !!state.resumedOffline;
  useEffect(() => {
    if (!resumedOffline) return;
    // Back online: confirm the session. Success emits `refreshed`; a rejected
    // cookie emits `ended`; another network failure waits for the next try.
    const confirm = () => {
      if (connectivity.get().online) client.refreshSession().catch(() => undefined);
    };
    confirm();
    return connectivity.subscribe(confirm);
  }, [resumedOffline]);

  const login = useCallback(async (username: string, password: string) => {
    const { user } = await client.login(username, password);
    setState({ status: 'authenticated', user });
    void rememberedUser.save(user);
    return user;
  }, []);

  const logout = useCallback(() => client.logout(), []);

  const value = useMemo(() => ({ ...state, login, logout }), [state, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
