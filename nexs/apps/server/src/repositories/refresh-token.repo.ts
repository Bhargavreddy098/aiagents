import type { PrismaClient, RefreshToken } from '@prisma/client';
import type { UserWithTenant } from './user.repo.js';

export type RefreshTokenWithUser = RefreshToken & { user: UserWithTenant };

export class RefreshTokenRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * The auth path deliberately bypasses tenant scoping (the caller is not yet
   * authenticated). The user — and its tenant — are joined so rotation can mint a
   * new access token and build the response without further unscoped lookups.
   */
  async findByHash(tokenHash: string): Promise<RefreshTokenWithUser | null> {
    return this.db.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { include: { tenant: true } } },
    });
  }

  async create(data: {
    userId: string;
    family: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RefreshToken> {
    return this.db.refreshToken.create({ data });
  }

  /** Rotate: revoke the presented token and issue its successor atomically. */
  async rotate(
    oldTokenId: string,
    next: { userId: string; family: string; tokenHash: string; expiresAt: Date },
  ): Promise<void> {
    await this.db.$transaction([
      this.db.refreshToken.update({
        where: { id: oldTokenId },
        data: { revokedAt: new Date() },
      }),
      this.db.refreshToken.create({ data: next }),
    ]);
  }

  /**
   * Reuse of any token in a family means the family is compromised: revoke all of it.
   * Returns the number of tokens revoked.
   */
  async revokeFamily(family: string): Promise<number> {
    const { count } = await this.db.refreshToken.updateMany({
      where: { family, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const { count } = await this.db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  async countActiveForUser(userId: string): Promise<number> {
    return this.db.refreshToken.count({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
  }
}
