import type { Tenant, User } from '@prisma/client';
import { ApiError, type AuthUser, type LoginInput, type SignupInput } from '@nexs/shared';
import type { Logger } from '../../logger.js';
import { isUniqueViolation } from '../../db-errors.js';
import { toAuthUser } from '../../mappers/user.js';
import type { RefreshTokenRepo, TenantRepo, UserRepo } from '../../repositories/ports.js';
import { burnPasswordWork, hashPassword, verifyPassword } from './password.js';
import type { TokenService } from './token.service.js';

export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface AuthResult {
  user: AuthUser;
  tokens: SessionTokens;
}

export interface AuthServiceDeps {
  users: UserRepo;
  tenants: TenantRepo;
  refreshTokens: RefreshTokenRepo;
  tokens: TokenService;
  logger: Logger;
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async signup(input: SignupInput): Promise<AuthResult> {
    const passwordHash = await hashPassword(input.password);
    const tenantName = input.tenantName ?? `${input.name}'s workspace`;

    let created: { tenant: Tenant; user: User };
    try {
      created = await this.deps.tenants.createWithOwner({
        tenantName,
        email: input.email,
        passwordHash,
        userName: input.name,
      });
    } catch (err) {
      // Uniqueness is decided by the database, so a concurrent signup with the same
      // email surfaces here as a constraint violation rather than a pre-flight check.
      if (isUniqueViolation(err, 'email')) {
        throw new ApiError('CONFLICT', 'An account with this email already exists');
      }
      throw err;
    }

    const tokens = await this.issueSession(created.user);
    return { user: toAuthUser(created.user, created.tenant.name), tokens };
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const user = await this.deps.users.findByEmail(input.email);

    if (user === null) {
      await burnPasswordWork(input.password);
      throw new ApiError('UNAUTHORIZED', 'Invalid email or password');
    }

    const passwordOk = await verifyPassword(user.passwordHash, input.password);
    if (!passwordOk) {
      // Same message as the unknown-email branch: never say which half was wrong.
      throw new ApiError('UNAUTHORIZED', 'Invalid email or password');
    }

    const tokens = await this.issueSession(user);
    return { user: toAuthUser(user, user.tenant.name), tokens };
  }

  /**
   * Rotation with theft detection.
   *
   * Every refresh token belongs to a *family* created at login and extended on each
   * rotation. A well-behaved client always presents the newest token, so seeing a
   * token that is already revoked means one of two things: it was stolen and the
   * thief got there first, or the real client replayed a stale token. We cannot tell
   * those apart, so we assume the worse one and revoke the entire family — the user
   * has to log in again, and the attacker's copy is dead too.
   */
  async refresh(rawRefreshToken: string): Promise<AuthResult> {
    const row = await this.deps.refreshTokens.findByHash(
      this.deps.tokens.hashSecret(rawRefreshToken),
    );

    if (row === null) {
      throw new ApiError('UNAUTHORIZED', 'Invalid refresh token');
    }

    if (row.revokedAt !== null) {
      const revoked = await this.deps.refreshTokens.revokeFamily(row.family);
      this.deps.logger.warn(
        { userId: row.userId, family: row.family, revoked },
        'refresh token reuse detected — token family revoked',
      );
      throw new ApiError('UNAUTHORIZED', 'Refresh token has been revoked');
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      throw new ApiError('UNAUTHORIZED', 'Refresh token has expired');
    }

    const access = await this.deps.tokens.signAccessToken({
      userId: row.user.id,
      tenantId: row.user.tenantId,
      tokenVersion: row.user.tokenVersion,
    });
    const next = this.deps.tokens.newOpaqueSecret();
    const refreshTokenExpiresAt = this.deps.tokens.refreshExpiry();

    await this.deps.refreshTokens.rotate(row.id, {
      userId: row.userId,
      family: row.family,
      tokenHash: next.tokenHash,
      expiresAt: refreshTokenExpiresAt,
    });

    return {
      user: toAuthUser(row.user, row.user.tenant.name),
      tokens: {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: next.token,
        refreshTokenExpiresAt,
      },
    };
  }

  /** Idempotent: logging out twice, or with a bogus token, is not an error. */
  async logout(rawRefreshToken: string): Promise<void> {
    const row = await this.deps.refreshTokens.findByHash(
      this.deps.tokens.hashSecret(rawRefreshToken),
    );
    if (row === null) return;
    await this.deps.refreshTokens.revokeFamily(row.family);
  }

  /** One login, one family: this is where a refresh chain begins. */
  private async issueSession(user: User): Promise<SessionTokens> {
    const access = await this.deps.tokens.signAccessToken({
      userId: user.id,
      tenantId: user.tenantId,
      tokenVersion: user.tokenVersion,
    });
    const secret = this.deps.tokens.newOpaqueSecret();
    const refreshTokenExpiresAt = this.deps.tokens.refreshExpiry();

    await this.deps.refreshTokens.create({
      userId: user.id,
      family: this.deps.tokens.newFamily(),
      tokenHash: secret.tokenHash,
      expiresAt: refreshTokenExpiresAt,
    });

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: secret.token,
      refreshTokenExpiresAt,
    };
  }
}
