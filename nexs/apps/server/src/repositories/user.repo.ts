import type { PrismaClient, Tenant, User } from '@prisma/client';

/** The tenant is joined on the auth path so a response can carry `tenantName`. */
export type UserWithTenant = User & { tenant: Tenant };

/**
 * Tenant-scoping rule (enforced by review + tests):
 * every method that touches tenant-owned data takes `tenantId` FIRST and includes it
 * in the `where` clause. Updates use `updateMany` with `{ id, tenantId }` rather than
 * `update({ where: { id } })`, because the latter would happily write across tenants.
 */
export class UserRepository {
  constructor(private readonly db: PrismaClient) {}

  /** Auth-path lookup: the tenant is not yet known before login, so this is unscoped. */
  async findByEmail(email: string): Promise<UserWithTenant | null> {
    return this.db.user.findUnique({ where: { email }, include: { tenant: true } });
  }

  async findById(tenantId: string, id: string): Promise<User | null> {
    return this.db.user.findFirst({ where: { id, tenantId } });
  }

  /**
   * Every member of a tenant.
   *
   * Added for approval fan-out: an approval request has no natural single owner while the
   * schema has no roles, so the notification goes to everyone who could act on it. Ordered
   * by creation so the recipient list is stable across calls — a test asserting on
   * "everyone was told" should not depend on the storage order of the user table.
   */
  async listByTenant(tenantId: string): Promise<User[]> {
    return this.db.user.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
  }

  async create(data: {
    tenantId: string;
    email: string;
    passwordHash: string;
    name: string;
  }): Promise<User> {
    return this.db.user.create({ data });
  }

  async updateName(tenantId: string, id: string, name: string): Promise<number> {
    const { count } = await this.db.user.updateMany({ where: { id, tenantId }, data: { name } });
    return count;
  }

  /**
   * Changing a password invalidates every existing session by bumping tokenVersion,
   * so access tokens minted before the change can be rejected.
   */
  async updatePasswordAndBumpVersion(
    tenantId: string,
    id: string,
    passwordHash: string,
  ): Promise<number> {
    const { count } = await this.db.user.updateMany({
      where: { id, tenantId },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });
    return count;
  }
}
