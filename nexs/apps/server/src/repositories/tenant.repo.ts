import type { PrismaClient, Tenant, User } from '@prisma/client';

export class TenantRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(name: string): Promise<Tenant> {
    return this.db.tenant.create({ data: { name } });
  }

  /**
   * Signup must never leave a tenant without its owner (or vice versa), so both
   * inserts share one transaction. The email uniqueness check is left to the
   * database: a pre-flight `SELECT` would race two concurrent signups.
   */
  async createWithOwner(data: {
    tenantName: string;
    email: string;
    passwordHash: string;
    userName: string;
  }): Promise<{ tenant: Tenant; user: User }> {
    return this.db.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data: { name: data.tenantName } });
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: data.email,
          passwordHash: data.passwordHash,
          name: data.userName,
        },
      });
      return { tenant, user };
    });
  }

  async findById(tenantId: string): Promise<Tenant | null> {
    return this.db.tenant.findUnique({ where: { id: tenantId } });
  }

  async updateName(tenantId: string, name: string): Promise<number> {
    const { count } = await this.db.tenant.updateMany({ where: { id: tenantId }, data: { name } });
    return count;
  }

  /**
   * Set or clear the command owner (UI/UX v2 §5.6).
   *
   * `null` clears it, and clearing is a legitimate operation: it is how an operator deliberately
   * puts a workspace back into the state where no exec approval can be granted — for instance
   * while auditing which standing permissions were handed out. A method that could only ever set
   * an owner would leave no way back to that state short of editing the database.
   *
   * `ownerUserId` is a plain column rather than a relation, matching the tenant-isolation rule
   * this schema follows everywhere: whether the id names a real user is the service's business,
   * and a foreign key here would make it impossible to clear the owner without a second write
   * ordering problem.
   */
  async setOwner(tenantId: string, ownerUserId: string | null): Promise<Tenant | null> {
    const { count } = await this.db.tenant.updateMany({
      where: { id: tenantId },
      data: { ownerUserId },
    });
    if (count !== 1) return null;
    return this.findById(tenantId);
  }
}
