/**
 * Repository ports.
 *
 * The concrete repositories are thin wrappers over Prisma; these `Pick`-derived
 * types are the surface the services actually depend on. Services type their
 * dependencies against a port, never against `PrismaClient`, which is what makes
 * the auth logic testable against an in-memory fake with no database.
 *
 * `Pick<>` (rather than a hand-written interface) is deliberate: the port can never
 * drift from the implementation — change a repository signature and the port, and
 * therefore every fake, stops compiling.
 */
import type { PasswordResetRepository } from './password-reset.repo.js';
import type { RefreshTokenRepository } from './refresh-token.repo.js';
import type { TenantRepository } from './tenant.repo.js';
import type { UserRepository } from './user.repo.js';

export type UserRepo = Pick<
  UserRepository,
  'findByEmail' | 'findById' | 'create' | 'updateName' | 'updatePasswordAndBumpVersion'
>;

export type TenantRepo = Pick<
  TenantRepository,
  'create' | 'findById' | 'updateName' | 'createWithOwner' | 'setOwner'
>;

export type RefreshTokenRepo = Pick<
  RefreshTokenRepository,
  'findByHash' | 'create' | 'rotate' | 'revokeFamily' | 'revokeAllForUser' | 'countActiveForUser'
>;

export type PasswordResetRepo = Pick<
  PasswordResetRepository,
  'create' | 'findByHash' | 'markUsed' | 'deleteAllForUser'
>;
