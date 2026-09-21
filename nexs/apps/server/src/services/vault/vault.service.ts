import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { ApiError } from '@nexs/shared';

/**
 * AES-256-GCM for provider credentials.
 *
 * The stored format is `v1:<base64 nonce>:<base64 ciphertext||tag>` — the version
 * prefix is what makes key rotation possible later without a flag day.
 *
 * GCM is authenticated, so a tampered ciphertext fails to decrypt rather than
 * returning garbage. The plaintext never leaves this class: callers ask for a
 * decrypted key only at the moment they are about to make a provider call.
 *
 * ## There is no `NEXS_MASTER_KEY`
 *
 * There used to be: a second secret to generate, keep, and get wrong, whose only job was to
 * encrypt the credentials that are already protected by being in the database. It is gone, and
 * the key is now **derived** from `JWT_SECRET` — the one secret the app cannot start without.
 *
 * Deriving rather than reusing the raw bytes is the point of the HKDF step below: the vault key
 * and the token-signing key are different 32-byte strings from the same input, so neither is
 * recoverable from the other, and a leaked ciphertext never sits next to the key that opens it.
 *
 * The cost, stated plainly: **rotating `JWT_SECRET` makes every stored credential
 * undecryptable.** That is a real coupling and it is the price of one secret instead of two.
 * Rotating it means re-entering provider keys, connector tokens and MCP environment blocks.
 */
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12; // 96 bits, the size GCM is defined for
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

/**
 * Domain separation for the derivation.
 *
 * The salt and info strings are part of the key's identity: changing either produces a
 * different vault key from the same secret, which is why they are constants with a version
 * and not inline strings at the call site.
 */
const HKDF_SALT = 'nexs.vault.v1';
const HKDF_INFO = 'provider-credential-encryption';

/** The 32 bytes AES-256 needs, derived from the app's signing secret. */
export function deriveVaultKey(signingSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', signingSecret, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

export class VaultService {
  private readonly key: Buffer;

  /**
   * @param signingSecret `config.JWT_SECRET`. The vault key is derived from it — see the file
   *   header for why there is no separate master key, and what rotation costs.
   */
  constructor(signingSecret: string) {
    if (signingSecret.length < KEY_BYTES) {
      // `loadConfig` already enforces 32 characters on `JWT_SECRET`, so reaching this means the
      // vault was constructed outside the composition root. Fail loudly rather than derive a
      // weak key from a short string.
      throw new Error(
        `The vault needs a signing secret of at least ${KEY_BYTES} characters to derive a key from, got ${signingSecret.length}.`,
      );
    }
    this.key = deriveVaultKey(signingSecret);
  }

  encrypt(plaintext: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, nonce);
    const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${nonce.toString('base64')}:${Buffer.concat([sealed, tag]).toString('base64')}`;
  }

  decrypt(encrypted: string): string {
    const parts = encrypted.split(':');
    if (parts.length !== 3 || parts[0] !== VERSION) {
      throw new ApiError('ENCRYPTION_ERROR', 'Malformed ciphertext');
    }

    const nonce = Buffer.from(parts[1]!, 'base64');
    const payload = Buffer.from(parts[2]!, 'base64');
    // `<` not `<=`: a payload of exactly TAG_BYTES is the tag with an empty ciphertext,
    // which is what encrypting the empty string produces. Rejecting it would make
    // `encrypt` and `decrypt` disagree about a value the vault itself created.
    if (nonce.length !== NONCE_BYTES || payload.length < TAG_BYTES) {
      throw new ApiError('ENCRYPTION_ERROR', 'Malformed ciphertext');
    }

    const tag = payload.subarray(payload.length - TAG_BYTES);
    const sealed = payload.subarray(0, payload.length - TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, this.key, nonce);
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(sealed), decipher.final()]).toString('utf8');
    } catch {
      // Tag mismatch means the wrong key or a tampered row. Never echo the input.
      throw new ApiError('ENCRYPTION_ERROR', 'Could not decrypt credential');
    }
  }

  /** UI masking only. Never derive anything security-relevant from this. */
  static mask(plaintext: string): string {
    if (plaintext.length <= 8) return '••••••';
    return `${plaintext.slice(0, 3)}…${plaintext.slice(-4)}`;
  }
}
