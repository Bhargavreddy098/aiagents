import { ApiError, type AuthContext, type AuthUser, type SetOwnerInput, type UpdateMeInput } from '@nexs/shared';
import { toAuthUser } from '../mappers/user.js';
import type { TenantRepo, UserRepo } from '../repositories/ports.js';

export interface UserServiceDeps {
  users: UserRepo;
  tenants: TenantRepo;
}

export class UserService {
  constructor(private readonly deps: UserServiceDeps) {}

  async getProfile(auth: AuthContext): Promise<AuthUser> {
    const [user, tenant] = await Promise.all([
      this.deps.users.findById(auth.tenantId, auth.userId),
      this.deps.tenants.findById(auth.tenantId),
    ]);

    if (user === null || tenant === null) {
      throw new ApiError('NOT_FOUND', 'Account not found');
    }

    return toAuthUser(user, tenant.name);
  }

  async updateProfile(auth: AuthContext, input: UpdateMeInput): Promise<AuthUser> {
    if (input.name !== undefined) {
      const updated = await this.deps.users.updateName(auth.tenantId, auth.userId, input.name);
      // A zero row count means the id/tenant pair matched nothing — the same
      // tenant-scoped `updateMany` that makes cross-tenant writes impossible also
      // tells us the account is gone.
      if (updated === 0) throw new ApiError('NOT_FOUND', 'Account not found');
    }

    return this.getProfile(auth);
  }

  /**
   * Claim or transfer the command owner (§5.6).
   *
   * ## The two halves of the rule
   *
   * An **unowned** workspace may be claimed by any authenticated member. That is the bootstrap
   * §5.6 describes — "from first pairing bootstrap or set in Settings" — and the alternative
   * (nobody can ever become the owner) would leave the exec gate permanently closed with no way
   * to open it from inside the product.
   *
   * Once an owner exists, **only the owner** may transfer or clear it. That asymmetry is the whole
   * security story: the claim is a one-time act in a workspace with no privileges to take, while
   * every later change is one privilege taking itself away from another.
   *
   * `claimed` is returned so the caller and the log can distinguish a first claim from a
   * transfer. They are the same row write and completely different events.
   */
  async setOwner(
    auth: AuthContext,
    input: SetOwnerInput,
  ): Promise<{ ownerUserId: string | null; claimed: boolean }> {
    const tenant = await this.deps.tenants.findById(auth.tenantId);
    if (tenant === null) throw new ApiError('NOT_FOUND', 'Account not found');

    const currentOwner = tenant.ownerUserId ?? null;

    if (currentOwner !== null && currentOwner !== auth.userId) {
      throw new ApiError('FORBIDDEN', 'Only the current command owner may change ownership', {
        ownerUserId: currentOwner,
      });
    }

    const updated = await this.deps.tenants.setOwner(auth.tenantId, input.ownerUserId);
    if (updated === null) throw new ApiError('NOT_FOUND', 'Account not found');

    return { ownerUserId: updated.ownerUserId ?? null, claimed: currentOwner === null };
  }
}
