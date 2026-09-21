import { describe, expect, it } from 'vitest';
import type { ApiError } from '@nexs/shared';
import { VaultService, deriveVaultKey } from '../src/services/vault/vault.service.js';

/**
 * Credential encryption.
 *
 * A provider API key is the most damaging thing in this database to leak, so the tests
 * below are as much about what the vault *refuses* to do as about what it does: a
 * tampered row must fail to decrypt rather than return plausible garbage, and the
 * plaintext must never be recoverable from the stored form.
 *
 * Two *signing secrets* rather than two base64 keys, because the vault key is now derived from
 * `JWT_SECRET` — see the file header of `vault.service.ts` for why the separate `NEXS_MASTER_KEY`
 * is gone and what rotating the secret costs.
 */

const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);

const vault = new VaultService(SECRET);

describe('VaultService — construction', () => {
  it('requires a signing secret long enough to derive a key from', () => {
    // HKDF will derive 32 bytes from a four-character secret without complaint, so the check is
    // what stops a vault constructed outside `loadConfig` from being built on a guessable string.
    expect(() => new VaultService('short')).toThrow(/at least 32 characters/);
    expect(() => new VaultService('')).toThrow(/at least 32 characters/);
  });

  it('accepts a well-formed signing secret', () => {
    expect(() => new VaultService(SECRET)).not.toThrow();
  });

  it('derives the same key every time, so a restart can still read the table', () => {
    // The property that makes a derived key usable at all: the derivation is deterministic, so a
    // new process with the same secret decrypts what the old one wrote.
    const plaintext = 'sk-proj-survives-a-restart';
    const encrypted = new VaultService(SECRET).encrypt(plaintext);
    expect(new VaultService(SECRET).decrypt(encrypted)).toBe(plaintext);
  });

  it('is 32 bytes and is not the signing secret itself', () => {
    // Domain-separated on purpose: if the vault key were the secret's own bytes, one leak would
    // be two leaks — token forgery and every stored credential.
    expect(deriveVaultKey(SECRET)).toHaveLength(32);
    expect(deriveVaultKey(SECRET).toString('utf8')).not.toBe(SECRET);
  });

  it('derives a different key for a different secret', () => {
    expect(deriveVaultKey(SECRET).equals(deriveVaultKey(OTHER_SECRET))).toBe(false);
  });
});

describe('VaultService — round trip', () => {
  it('recovers the plaintext', () => {
    const plaintext = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
    expect(vault.decrypt(vault.encrypt(plaintext))).toBe(plaintext);
  });

  it('handles unicode and empty strings', () => {
    expect(vault.decrypt(vault.encrypt(''))).toBe('');
    expect(vault.decrypt(vault.encrypt('clé-🔑-密钥'))).toBe('clé-🔑-密钥');
  });

  it('never stores the plaintext, or anything derived from it predictably', () => {
    const plaintext = 'sk-live-supersecret';
    const encrypted = vault.encrypt(plaintext);

    expect(encrypted).not.toContain(plaintext);
    expect(encrypted).not.toContain('supersecret');
    expect(encrypted.startsWith('v1:')).toBe(true);
  });

  it('produces a different ciphertext every time', () => {
    // A fresh nonce per encryption. Identical ciphertexts would let anyone with read
    // access to the table see that two tenants had configured the same key.
    const first = vault.encrypt('same-value');
    const second = vault.encrypt('same-value');

    expect(first).not.toBe(second);
    expect(vault.decrypt(first)).toBe('same-value');
    expect(vault.decrypt(second)).toBe('same-value');
  });

  it('stores the nonce and the tag alongside the ciphertext', () => {
    const parts = vault.encrypt('value').split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('v1');
    expect(Buffer.from(parts[1]!, 'base64')).toHaveLength(12);
    // ciphertext + 16-byte GCM tag
    expect(Buffer.from(parts[2]!, 'base64').length).toBeGreaterThan(16);
  });
});

describe('VaultService — refusing bad input', () => {
  it('fails on a ciphertext encrypted with a different key', () => {
    const foreign = new VaultService(OTHER_SECRET).encrypt('secret');

    // GCM is authenticated, so this fails rather than returning noise.
    expect(() => vault.decrypt(foreign)).toThrow(/Could not decrypt/);
  });

  it('fails when the ciphertext has been tampered with', () => {
    const parts = vault.encrypt('secret').split(':');
    const payload = Buffer.from(parts[2]!, 'base64');
    payload[0] = payload[0]! ^ 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${payload.toString('base64')}`;

    expect(() => vault.decrypt(tampered)).toThrow(/Could not decrypt/);
  });

  it('fails when the authentication tag has been tampered with', () => {
    const parts = vault.encrypt('secret').split(':');
    const payload = Buffer.from(parts[2]!, 'base64');
    payload[payload.length - 1] = payload[payload.length - 1]! ^ 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${payload.toString('base64')}`;

    expect(() => vault.decrypt(tampered)).toThrow(/Could not decrypt/);
  });

  it('rejects a malformed stored value', () => {
    for (const bad of ['', 'not-a-ciphertext', 'v1:only-two-parts', 'v2:a:b', 'v1::']) {
      expect(() => vault.decrypt(bad), `expected "${bad}" to be rejected`).toThrow();
    }
  });

  it('reports every failure as an ENCRYPTION_ERROR rather than leaking the cause', () => {
    // The message must not echo the input: a decryption failure is often a wrong key, and
    // logging the ciphertext alongside it is how a key-rotation bug becomes a data leak.
    const error = (() => {
      try {
        vault.decrypt('v1:AAAA:BBBB');
        return null;
      } catch (err) {
        return err as ApiError;
      }
    })();

    expect(error?.code).toBe('ENCRYPTION_ERROR');
    expect(error?.http).toBe(500);
  });
});

describe('VaultService.mask', () => {
  it('shows just enough to identify a key', () => {
    expect(VaultService.mask('sk-proj-abcdefghijklmnop')).toBe('sk-…mnop');
  });

  it('reveals nothing at all for a short value', () => {
    // A short secret is mostly secret; showing three characters of an eight-character
    // token would give away a meaningful fraction of it.
    expect(VaultService.mask('short')).toBe('••••••');
    expect(VaultService.mask('12345678')).toBe('••••••');
  });
});
