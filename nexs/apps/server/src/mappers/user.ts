import type { User } from '@prisma/client';
import type { AuthUser } from '@nexs/shared';

/**
 * The single place a `User` row becomes the `AuthUser` wire shape.
 *
 * `AuthUser` is what the API returns, and it deliberately excludes `passwordHash`,
 * `tokenVersion` and `activeTokenFamily`. Mapping in one function means a new
 * sensitive column cannot leak by being spread into a response somewhere else.
 */
export function toAuthUser(
  user: Pick<User, 'id' | 'email' | 'name' | 'tenantId'>,
  tenantName: string,
): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    tenantId: user.tenantId,
    tenantName,
  };
}
