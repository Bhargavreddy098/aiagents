import { Algorithm, hash, verify } from '@node-rs/argon2';
import { ARGON2_PARAMS } from '@nexs/shared';

/**
 * argon2id via @node-rs/argon2 (prebuilt native bindings — no node-gyp at install).
 * Parameters live in @nexs/shared so the API, any future CLI, and the tests all hash
 * with identical cost. Changing them is a breaking change for existing hashes.
 */

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, { algorithm: Algorithm.Argon2id, ...ARGON2_PARAMS });
}

/** Never throws on a malformed hash — a corrupt row must fail closed, not 500. */
export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}

let dummyHash: string | null = null;

/**
 * Spend roughly the same work as a real verification when the account does not
 * exist. Without this, "unknown email" returns in ~1 ms while "wrong password"
 * takes ~20 ms, and that gap alone tells an attacker which emails are registered.
 */
export async function burnPasswordWork(plain: string): Promise<void> {
  const target = dummyHash ?? (dummyHash = await hashPassword('nexs-timing-equalizer'));
  await verifyPassword(target, plain);
}
