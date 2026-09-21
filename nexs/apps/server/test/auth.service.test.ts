import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { PasswordResetRepository } from '../src/repositories/password-reset.repo.js';
import { RefreshTokenRepository } from '../src/repositories/refresh-token.repo.js';
import { TenantRepository } from '../src/repositories/tenant.repo.js';
import { UserRepository } from '../src/repositories/user.repo.js';
import { AuthService } from '../src/services/auth/auth.service.js';
import { PasswordResetService } from '../src/services/auth/password-reset.service.js';
import { TokenService } from '../src/services/auth/token.service.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * Auth service behaviour, exercised end to end through the real repositories.
 *
 * The headline case is refresh-token reuse (gap #11): a stolen token must not be
 * usable, and its theft must not leave the legitimate successor alive either.
 */

const logger = pino({ level: 'silent' });

const VALID_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a completely different passphrase';

function build(): {
  fake: FakeDb;
  auth: AuthService;
  passwordResetService: PasswordResetService;
  tokens: TokenService;
} {
  const fake = createFakeDb();

  const tokens = new TokenService({
    jwtSecret: 'test-jwt-secret-that-is-at-least-32-chars-long',
    accessTokenTtlSec: 900,
    refreshTokenTtlDays: 30,
  });

  const users = new UserRepository(fake.client);
  const tenants = new TenantRepository(fake.client);
  const refreshTokens = new RefreshTokenRepository(fake.client);
  const passwordResets = new PasswordResetRepository(fake.client);

  return {
    fake,
    tokens,
    auth: new AuthService({ users, tenants, refreshTokens, tokens, logger }),
    passwordResetService: new PasswordResetService({
      users,
      passwordResets,
      refreshTokens,
      tokens,
    }),
  };
}

async function signupAda(auth: AuthService) {
  return auth.signup({ email: 'ada@example.com', password: VALID_PASSWORD, name: 'Ada' });
}

describe('AuthService', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  describe('signup', () => {
    it('creates a tenant with its owner and returns a usable session', async () => {
      const result = await signupAda(ctx.auth);

      expect(result.user.email).toBe('ada@example.com');
      expect(result.user.tenantName).toBe("Ada's workspace");
      expect(ctx.fake.tenants).toHaveLength(1);
      expect(ctx.fake.refreshTokens).toHaveLength(1);

      // The access token is real, not just a string.
      const claims = await ctx.tokens.verifyAccessToken(result.tokens.accessToken);
      expect(claims).toMatchObject({ sub: result.user.id, tenantId: result.user.tenantId, tv: 0 });
    });

    it('never stores the raw password or the raw refresh token', async () => {
      const result = await signupAda(ctx.auth);
      const user = ctx.fake.users[0]!;

      expect(user.passwordHash).not.toContain(VALID_PASSWORD);
      expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);

      // The refresh token is only ever persisted as a sha256 hash.
      expect(ctx.fake.refreshTokens[0]!.tokenHash).toBe(
        ctx.tokens.hashSecret(result.tokens.refreshToken),
      );
      expect(ctx.fake.refreshTokens[0]!.tokenHash).not.toBe(result.tokens.refreshToken);
    });

    it('rejects a duplicate email with CONFLICT', async () => {
      await signupAda(ctx.auth);

      await expect(signupAda(ctx.auth)).rejects.toMatchObject({ code: 'CONFLICT' });
      // The failed attempt must not leave an orphan tenant behind.
      expect(ctx.fake.tenants).toHaveLength(1);
      expect(ctx.fake.users).toHaveLength(1);
    });
  });

  describe('login', () => {
    it('rejects an unknown email and a wrong password identically', async () => {
      await signupAda(ctx.auth);

      // `.then(() => null)` normalises the success branch away, so the caught value is
      // the only thing left in the union and its fields can be read directly.
      const unknown = await ctx.auth
        .login({ email: 'nobody@example.com', password: VALID_PASSWORD })
        .then(() => null)
        .catch((e: { code?: string; message?: string }) => e);
      const wrong = await ctx.auth
        .login({ email: 'ada@example.com', password: 'not the password' })
        .then(() => null)
        .catch((e: { code?: string; message?: string }) => e);

      expect(unknown?.code).toBe('UNAUTHORIZED');
      expect(wrong?.code).toBe('UNAUTHORIZED');
      // Identical message: the response must not reveal which half was wrong.
      expect(unknown?.message).toBe(wrong?.message);
    });

    it('issues a new refresh-token family on every login', async () => {
      await signupAda(ctx.auth);
      await ctx.auth.login({ email: 'ada@example.com', password: VALID_PASSWORD });

      expect(ctx.fake.refreshTokens).toHaveLength(2);
      const families = new Set(ctx.fake.refreshTokens.map((r) => r.family));
      expect(families.size).toBe(2);
    });
  });

  describe('refresh — rotation', () => {
    it('rotates: the presented token is revoked and its successor works', async () => {
      const signup = await signupAda(ctx.auth);
      const first = signup.tokens.refreshToken;

      const rotated = await ctx.auth.refresh(first);
      const second = rotated.tokens.refreshToken;

      expect(second).not.toBe(first);
      expect(ctx.fake.refreshTokens.filter((r) => r.revokedAt === null)).toHaveLength(1);
      expect(ctx.fake.refreshTokens.find((r) => r.revokedAt !== null)!.tokenHash).toBe(
        ctx.tokens.hashSecret(first),
      );

      // The successor keeps the family, and stays in the same tenant.
      const rotatedAgain = await ctx.auth.refresh(second);
      expect(rotatedAgain.user.tenantId).toBe(signup.user.tenantId);
    });

    it('rejects an unknown refresh token', async () => {
      await expect(ctx.auth.refresh('not-a-real-token')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });

    it('rejects an expired refresh token', async () => {
      const signup = await signupAda(ctx.auth);
      ctx.fake.refreshTokens[0]!.expiresAt = new Date(Date.now() - 1_000);

      await expect(ctx.auth.refresh(signup.tokens.refreshToken)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('refresh — theft detection (gap #11)', () => {
    it('revokes the entire family when a rotated token is replayed', async () => {
      const signup = await signupAda(ctx.auth);
      const stolen = signup.tokens.refreshToken;

      // The legitimate client rotates; the attacker is now holding a stale token.
      const rotated = await ctx.auth.refresh(stolen);
      const legitimateSuccessor = rotated.tokens.refreshToken;
      expect(ctx.fake.refreshTokens.filter((r) => r.revokedAt === null)).toHaveLength(1);

      // The attacker replays the token they stole.
      await expect(ctx.auth.refresh(stolen)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      // Detection must be destructive: the family is burned, so the attacker cannot
      // keep using whatever they hold, and the real client is forced to log in again.
      expect(ctx.fake.refreshTokens.filter((r) => r.revokedAt === null)).toHaveLength(0);
      await expect(ctx.auth.refresh(legitimateSuccessor)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });

    it('does not touch a different family when one is burned', async () => {
      await signupAda(ctx.auth);

      // A second, unrelated session — as if Ada also logged in on her phone.
      const phone = await ctx.auth.login({ email: 'ada@example.com', password: VALID_PASSWORD });
      const desktop = await ctx.auth.login({ email: 'ada@example.com', password: VALID_PASSWORD });

      const familyOf = (token: string): string =>
        ctx.fake.refreshTokens.find((r) => r.tokenHash === ctx.tokens.hashSecret(token))!.family;

      const phoneFamily = familyOf(phone.tokens.refreshToken);
      const desktopFamily = familyOf(desktop.tokens.refreshToken);
      expect(phoneFamily).not.toBe(desktopFamily);

      // Burn the desktop family only.
      await ctx.auth.logout(desktop.tokens.refreshToken);
      expect(
        ctx.fake.refreshTokens.filter((r) => r.family === desktopFamily).every((r) => r.revokedAt !== null),
      ).toBe(true);

      // The phone session is untouched.
      expect(
        ctx.fake.refreshTokens.filter((r) => r.family === phoneFamily).every((r) => r.revokedAt === null),
      ).toBe(true);
      await expect(ctx.auth.refresh(phone.tokens.refreshToken)).resolves.toBeDefined();
    });
  });

  describe('logout', () => {
    it('revokes the family and is idempotent', async () => {
      const signup = await signupAda(ctx.auth);

      await ctx.auth.logout(signup.tokens.refreshToken);
      await expect(ctx.auth.refresh(signup.tokens.refreshToken)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });

      // Logging out again, or with a token that never existed, is not an error.
      await expect(ctx.auth.logout(signup.tokens.refreshToken)).resolves.toBeUndefined();
      await expect(ctx.auth.logout('never-existed')).resolves.toBeUndefined();
    });
  });

  describe('PasswordResetService', () => {
    it('does not reveal whether an email is registered', async () => {
      await expect(
        ctx.passwordResetService.request({ email: 'nobody@example.com' }),
      ).resolves.toEqual({ token: null });
    });

    it('invalidates the previous reset link when a new one is requested', async () => {
      await signupAda(ctx.auth);
      const first = await ctx.passwordResetService.request({ email: 'ada@example.com' });
      const second = await ctx.passwordResetService.request({ email: 'ada@example.com' });

      expect(ctx.fake.passwordResets).toHaveLength(1);
      await expect(
        ctx.passwordResetService.confirm({ token: first.token!, newPassword: NEW_PASSWORD }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(
        ctx.passwordResetService.confirm({ token: second.token!, newPassword: NEW_PASSWORD }),
      ).resolves.toBeUndefined();
    });

    it('changes the password and ends every existing session', async () => {
      const signup = await signupAda(ctx.auth);
      const before = await ctx.tokens.verifyAccessToken(signup.tokens.accessToken);
      expect(before).not.toBeNull();

      const { token } = await ctx.passwordResetService.request({ email: 'ada@example.com' });
      await ctx.passwordResetService.confirm({ token: token!, newPassword: NEW_PASSWORD });

      // Every refresh token for the user is dead.
      expect(ctx.fake.refreshTokens.every((r) => r.revokedAt !== null)).toBe(true);
      await expect(ctx.auth.refresh(signup.tokens.refreshToken)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });

      // The old access token still verifies cryptographically — that is the cost of
      // stateless JWTs — but its `tv` claim no longer matches the user row, which is
      // exactly what `createAuthRequired` checks.
      const claims = await ctx.tokens.verifyAccessToken(signup.tokens.accessToken);
      const row = ctx.fake.users.find((u) => u.id === signup.user.id)!;
      expect(claims).not.toBeNull();
      expect(claims!.tv).not.toBe(row.tokenVersion);
      expect(row.tokenVersion).toBe(1);

      // And the password actually changed.
      await expect(
        ctx.auth.login({ email: 'ada@example.com', password: VALID_PASSWORD }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(
        ctx.auth.login({ email: 'ada@example.com', password: NEW_PASSWORD }),
      ).resolves.toBeDefined();
    });

    it('treats a reset token as single-use', async () => {
      await signupAda(ctx.auth);
      const { token } = await ctx.passwordResetService.request({ email: 'ada@example.com' });

      await ctx.passwordResetService.confirm({ token: token!, newPassword: NEW_PASSWORD });
      await expect(
        ctx.passwordResetService.confirm({ token: token!, newPassword: 'a third passphrase' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('rejects an expired reset token', async () => {
      await signupAda(ctx.auth);
      const { token } = await ctx.passwordResetService.request({ email: 'ada@example.com' });
      ctx.fake.passwordResets[0]!.expiresAt = new Date(Date.now() - 1_000);

      await expect(
        ctx.passwordResetService.confirm({ token: token!, newPassword: NEW_PASSWORD }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });
});
