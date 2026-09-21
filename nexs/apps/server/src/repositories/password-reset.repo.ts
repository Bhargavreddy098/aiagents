import type { PasswordReset, PrismaClient } from '@prisma/client';
import type { UserWithTenant } from './user.repo.js';

export type PasswordResetWithUser = PasswordReset & { user: UserWithTenant };

export class PasswordResetRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Like refresh tokens, this is an unauthenticated path: the caller presents a
   * token and only then do we learn who they are.
   */
  async findByHash(tokenHash: string): Promise<PasswordResetWithUser | null> {
    return this.db.passwordReset.findUnique({
      where: { tokenHash },
      include: { user: { include: { tenant: true } } },
    });
  }

  async create(data: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<PasswordReset> {
    return this.db.passwordReset.create({ data });
  }

  /** Returns the number of rows marked, so a caller can detect a lost race. */
  async markUsed(id: string): Promise<number> {
    const { count } = await this.db.passwordReset.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: new Date() },
    });
    return count;
  }

  /**
   * Invalidate every other outstanding reset for this user. Requesting a new reset
   * link should kill the previous one, otherwise a leaked older link stays live.
   */
  async deleteAllForUser(userId: string): Promise<number> {
    const { count } = await this.db.passwordReset.deleteMany({ where: { userId } });
    return count;
  }
}
