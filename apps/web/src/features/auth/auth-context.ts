import type { UserDto } from '@pharmacy/shared';
import { createContext, useContext } from 'react';

export type AuthState =
  | { status: 'loading'; user: null }
  | { status: 'anonymous'; user: null }
  | {
      status: 'authenticated';
      user: UserDto;
      /**
       * Resumed after a reload while the server was unreachable, from the
       * user remembered on this device. No access token yet: the session is
       * confirmed (or ended) as soon as the server answers.
       */
      resumedOffline?: boolean;
    };

export type AuthContextValue = AuthState & {
  login: (username: string, password: string) => Promise<UserDto>;
  logout: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/** The signed-in user, for components that only render behind <RequireAuth>. */
export function useCurrentUser(): UserDto {
  const { user } = useAuth();
  if (!user) throw new Error('useCurrentUser used outside an authenticated route');
  return user;
}
