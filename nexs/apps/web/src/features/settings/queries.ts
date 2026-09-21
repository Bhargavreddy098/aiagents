/**
 * Settings queries.
 *
 * ## What Settings can actually write
 *
 * Two things, and no more:
 *
 *  - `PATCH /api/users/me` — the display name. `updateMeSchema` is `{ name? }` and nothing else:
 *    email and workspace name are not editable through any endpoint.
 *  - `PUT /api/users/owner` — claim, transfer or clear the command owner (§5.6).
 *
 * ## And what it can only describe
 *
 * There is no `settings`, `tenant` or `workspace` router. So notification preferences, a device
 * list and account deletion have no backend, and this module does not pretend otherwise — the
 * page states what is missing and offers the nearest real thing. The alternative is a form that
 * appears to save and does nothing, which is the failure mode the honesty rules exist to
 * prevent.
 *
 * The one place that pays off is security: there is no "change password" endpoint, but
 * `POST /api/auth/password-reset/request` and `/confirm` are a complete, working flow — and
 * outside production the request response **includes the token**, so it functions as an
 * in-session password change. That is a real capability and it is offered as one.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AuthUser } from '@nexs/shared';
import { api, apiOf } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

/** Rename the signed-in user. The only editable profile field there is. */
export function useUpdateProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiOf<AuthUser>('/users/me', 'user', { method: 'PATCH', body: { name } }),
    onSuccess: (user) => {
      // Written straight into the cache rather than invalidated: the response *is* the new
      // user, and a refetch would be a second read of the same row.
      client.setQueryData(queryKeys.auth.me, user);
    },
  });
}

export interface OwnerResult {
  ownerUserId: string | null;
  /**
   * True when the workspace had no owner and this call claimed it.
   *
   * The service returns it because the two outcomes are the same row write and completely
   * different events — a first claim, versus a privilege transferring itself. The page says
   * which happened.
   */
  claimed: boolean;
}

/**
 * Claim, transfer or clear the command owner.
 *
 * `ownerUserId: null` clears it, and that is a deliberate operation rather than an accident —
 * the schema is an explicit union for exactly that reason, because clearing ownership disables
 * the exec gate. The page warns before offering it.
 *
 * Note what this call does **not** do: read the current owner. `ownerUserId` is a column on
 * `Tenant` and no endpoint projects it, so the page cannot show who owns the workspace today —
 * only the result of the change it just made.
 */
export function useSetOwner() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ownerUserId: string | null) =>
      api<OwnerResult>('/users/owner', { method: 'PUT', body: { ownerUserId } }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.auth.me }),
  });
}

/**
 * Ask for a password reset link.
 *
 * Always 202, whether or not the address is registered — the endpoint is deliberately
 * indistinguishable for an unknown email, so a caller cannot use it to discover accounts.
 *
 * `token` is present **only outside production**, where no mail provider is wired up yet and
 * the flow would otherwise be uncompletable locally. In production it is absent and the token
 * travels by email. The page branches on that rather than assuming either.
 */
export function useRequestPasswordReset() {
  return useMutation({
    mutationFn: (email: string) =>
      api<{ ok: true; token?: string }>('/auth/password-reset/request', {
        method: 'POST',
        body: { email },
        // A wrong email here is not an expired session, and routing it through the session
        // handler would sign the user out of the page they are trying to secure.
        handleUnauthorized: false,
      }),
  });
}

/**
 * Complete a reset with the token and a new password.
 *
 * Answers 204 and revokes every refresh token for the user — including this browser's — which
 * is why the server also clears the cookies. The page therefore has to treat success as
 * "you will need to sign in again" rather than as a silent change.
 */
export function useConfirmPasswordReset() {
  return useMutation({
    mutationFn: (input: { token: string; newPassword: string }) =>
      api<void>('/auth/password-reset/confirm', {
        method: 'POST',
        body: input,
        handleUnauthorized: false,
      }),
  });
}
