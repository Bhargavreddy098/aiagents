/**
 * Who is signed in.
 *
 * ## The 401 is not an error here
 *
 * `GET /api/users/me` answers 401 for a signed-out visitor, and that is the *expected*
 * answer, not a failure. So the query disables retries and treats a 401 as data — `user:
 * null` — rather than as an error state. A provider that surfaced it as an error would
 * render an error box on the login page, which is a page nobody is signed in on.
 *
 * Any *other* failure (a 500, a dead network) is a real error and is left to propagate, so
 * the app shows "could not reach the server" instead of silently pretending to be signed
 * out. Those are different facts and the UI must not conflate them.
 *
 * ## One 401 handler, registered once
 *
 * `api.ts` calls a module-level handler when any request answers 401 — an expired access
 * token, or a password change that bumped `tokenVersion`. The handler writes `null` into
 * the `me` cache, which flips `RequireAuth` to the login page without a full reload and
 * without every page having to inspect its own errors.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthUser, LoginInput, SignupInput } from '@nexs/shared';
import { ApiClientError, apiOf, setUnauthorizedHandler } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  /** True only while the first `me` read is in flight. */
  isLoading: boolean;
  /** A failure that is *not* "signed out" — a 500, or no network. */
  loadError: unknown;
  login: (input: LoginInput) => Promise<void>;
  signup: (input: SignupInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 401;
}

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const client = useQueryClient();

  const meQuery = useQuery({
    queryKey: queryKeys.auth.me,
    queryFn: async (): Promise<AuthUser | null> => {
      try {
        return await apiOf<AuthUser>('/users/me', 'user');
      } catch (err) {
        // Signed out, not broken. See the file header.
        if (isUnauthorized(err)) return null;
        throw err;
      }
    },
    // A 401 here is an answer, so there is nothing to retry. A real failure is retried once
    // by the default policy, which is what makes a flaky start recover on its own.
    retry: (failureCount, error) => !isUnauthorized(error) && failureCount < 1,
    staleTime: 30_000,
  });

  useEffect(() => {
    setUnauthorizedHandler(() => {
      client.setQueryData(queryKeys.auth.me, null);
    });
    return () => setUnauthorizedHandler(null);
  }, [client]);

  const login = useCallback(
    async (input: LoginInput): Promise<void> => {
      // `handleUnauthorized: false` — a 401 from login means the credentials are wrong, and
      // routing it through the session handler would clear a session that never existed.
      const user = await apiOf<AuthUser>('/auth/login', 'user', {
        method: 'POST',
        body: input,
        handleUnauthorized: false,
      });
      client.setQueryData(queryKeys.auth.me, user);
    },
    [client],
  );

  const signup = useCallback(
    async (input: SignupInput): Promise<void> => {
      const user = await apiOf<AuthUser>('/auth/signup', 'user', {
        method: 'POST',
        body: input,
        handleUnauthorized: false,
      });
      client.setQueryData(queryKeys.auth.me, user);
    },
    [client],
  );

  const logoutMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      await apiOf<null>('/auth/logout', 'user', { method: 'POST' }).catch(() => undefined);
    },
  });

  const logout = useCallback(async (): Promise<void> => {
    await logoutMutation.mutateAsync().catch(() => undefined);
    // Everything cached belongs to the session that just ended. Clearing is not just
    // tidiness: leaving another tenant's rows in the cache across a re-login is the client
    // half of the isolation the server enforces on every query.
    client.clear();
    client.setQueryData(queryKeys.auth.me, null);
  }, [client, logoutMutation]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: meQuery.data ?? null,
      isAuthenticated: (meQuery.data ?? null) !== null,
      isLoading: meQuery.isPending,
      loadError: meQuery.isError ? meQuery.error : null,
      login,
      signup,
      logout,
    }),
    [meQuery.data, meQuery.isPending, meQuery.isError, meQuery.error, login, signup, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
