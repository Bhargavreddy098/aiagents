import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { AccessTokenClaims } from '@nexs/shared';

/**
 * Two different kinds of token, deliberately:
 *
 *  - The **access token** is a short-lived HS256 JWT. It is stateless, so verifying
 *    it costs no query; the `tv` claim is what lets a password change invalidate
 *    tokens that are still inside their TTL.
 *  - The **refresh token** is an opaque 32-byte random string. It carries no
 *    information, so it cannot be forged or tampered with, and it is stored only as
 *    a sha256 hash — a database leak does not hand over live sessions.
 *
 * The same opaque-secret machinery backs password-reset tokens.
 */

const ALG = 'HS256';
const ISSUER = 'nexs';
const AUDIENCE = 'nexs-api';

export interface OpaqueSecret {
  /** The value handed to the client. Never persisted. */
  token: string;
  /** sha256 hex of `token` — the only form that reaches the database. */
  tokenHash: string;
}

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

export class TokenService {
  private readonly key: Uint8Array;
  private readonly accessTtlSec: number;
  private readonly refreshTtlMs: number;

  constructor(opts: {
    jwtSecret: string;
    accessTokenTtlSec: number;
    refreshTokenTtlDays: number;
  }) {
    this.key = new TextEncoder().encode(opts.jwtSecret);
    this.accessTtlSec = opts.accessTokenTtlSec;
    this.refreshTtlMs = opts.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
  }

  async signAccessToken(input: {
    userId: string;
    tenantId: string;
    tokenVersion: number;
  }): Promise<SignedAccessToken> {
    const issuedAtSec = Math.floor(Date.now() / 1000);
    const expiresAtSec = issuedAtSec + this.accessTtlSec;

    const token = await new SignJWT({
      tenantId: input.tenantId,
      typ: 'access',
      tv: input.tokenVersion,
    })
      .setProtectedHeader({ alg: ALG })
      .setSubject(input.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAtSec)
      .setExpirationTime(expiresAtSec)
      .sign(this.key);

    return { token, expiresAt: new Date(expiresAtSec * 1000) };
  }

  /**
   * Returns `null` for anything that is not a currently-valid access token —
   * expired, tampered, wrong issuer/audience, or structurally wrong. Callers turn
   * that into a 401; there is no reason to distinguish the failure modes to a client.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [ALG],
      });

      const tenantId = payload['tenantId'];
      const tv = payload['tv'];
      if (
        payload['typ'] !== 'access' ||
        typeof payload.sub !== 'string' ||
        typeof tenantId !== 'string' ||
        typeof tv !== 'number'
      ) {
        return null;
      }

      return { sub: payload.sub, tenantId, typ: 'access', tv };
    } catch {
      return null;
    }
  }

  newOpaqueSecret(): OpaqueSecret {
    // base64url of 32 bytes = 43 chars, URL- and cookie-safe with no padding.
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: this.hashSecret(token) };
  }

  /**
   * sha256, not argon2: these tokens are already 256 bits of entropy, so there is
   * nothing to brute-force and password-hashing cost would only add latency.
   */
  hashSecret(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** A family id groups every refresh token descended from one login. */
  newFamily(): string {
    return randomUUID();
  }

  refreshExpiry(): Date {
    return new Date(Date.now() + this.refreshTtlMs);
  }
}
