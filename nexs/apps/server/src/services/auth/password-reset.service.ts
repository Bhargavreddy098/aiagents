import {
  ApiError,
  PASSWORD_RESET_TTL_MS,
  type PasswordResetConfirmInput,
  type PasswordResetRequestInput,
} from '@nexs/shared';
import type { PasswordResetRepo, RefreshTokenRepo, UserRepo } from '../../repositories/ports.js';
import { hashPassword } from './password.js';
import type { TokenService } from './token.service.js';

export interface PasswordResetServiceDeps {
  users: UserRepo;
  passwordResets: PasswordResetRepo;
  refreshTokens: RefreshTokenRepo;
  tokens: TokenService;
}

export class PasswordResetService {
  constructor(private readonly deps: PasswordResetServiceDeps) {}

  /**
   * Always reports success, even for an email that has no account. Returning a
   * distinct "no such user" would turn this endpoint into an account-enumeration
   * oracle — the caller learns who is registered without ever logging in.
   *
   * The raw token is returned so a local/dev environment can complete the flow
   * without an email provider; the caller must not expose it in production.
   */
  async request(input: PasswordResetRequestInput): Promise<{ token: string | null }> {
    const user = await this.deps.users.findByEmail(input.email);
    if (user === null) return { token: null };

    const secret = this.deps.tokens.newOpaqueSecret();

    // Requesting a new link invalidates the previous one, so an older leaked link
    // cannot be used after the user asks for another.
    await this.deps.passwordResets.deleteAllForUser(user.id);
    await this.deps.passwordResets.create({
      userId: user.id,
      tokenHash: secret.tokenHash,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    });

    return { token: secret.token };
  }

  async confirm(input: PasswordResetConfirmInput): Promise<void> {
    const row = await this.deps.passwordResets.findByHash(
      this.deps.tokens.hashSecret(input.token),
    );

    if (row === null || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) {
      throw new ApiError('UNAUTHORIZED', 'Password reset token is invalid or has expired');
    }

    const passwordHash = await hashPassword(input.newPassword);

    // Claim the token *before* writing the password. `markUsed` is a conditional
    // update, so if two requests race with the same token exactly one gets count=1
    // and the loser cannot change the password.
    const claimed = await this.deps.passwordResets.markUsed(row.id);
    if (claimed === 0) {
      throw new ApiError('UNAUTHORIZED', 'Password reset token is invalid or has expired');
    }

    // Bumping tokenVersion invalidates every access token already issued.
    await this.deps.users.updatePasswordAndBumpVersion(row.user.tenantId, row.userId, passwordHash);
    await this.deps.passwordResets.deleteAllForUser(row.userId);
    // A password change ends every existing session, on every device.
    await this.deps.refreshTokens.revokeAllForUser(row.userId);
  }
}
