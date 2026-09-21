import { describe, expect, it } from 'vitest';
import { TenantRepository } from '../src/repositories/tenant.repo.js';
import { UserRepository } from '../src/repositories/user.repo.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * The tenant-isolation rule, tested against the real repository code.
 *
 * The rule: `tenantId` is the first argument of every tenant-owned method and is part
 * of every `where` clause. These tests exist because that rule is the one thing a
 * later refactor is most likely to break silently — a repository that drops the
 * `tenantId` filter still passes every other test in the suite.
 */

const at = new Date('2026-01-01T00:00:00.000Z');

function seedTwoTenants(): FakeDb {
  const fake = createFakeDb();

  fake.tenants.push(
    { id: 'tnt_a', name: 'Tenant A', createdAt: at, updatedAt: at },
    { id: 'tnt_b', name: 'Tenant B', createdAt: at, updatedAt: at },
  );

  fake.users.push(
    {
      id: 'usr_a',
      tenantId: 'tnt_a',
      email: 'ada@example.com',
      passwordHash: 'hash-a',
      name: 'Ada',
      activeTokenFamily: null,
      tokenVersion: 0,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'usr_b',
      tenantId: 'tnt_b',
      email: 'bob@example.com',
      passwordHash: 'hash-b',
      name: 'Bob',
      activeTokenFamily: null,
      tokenVersion: 0,
      createdAt: at,
      updatedAt: at,
    },
  );

  return fake;
}

describe('tenant isolation', () => {
  it('findById will not return a user that belongs to another tenant', async () => {
    const fake = seedTwoTenants();
    const users = new UserRepository(fake.client);

    await expect(users.findById('tnt_a', 'usr_a')).resolves.toMatchObject({ id: 'usr_a' });
    await expect(users.findById('tnt_b', 'usr_b')).resolves.toMatchObject({ id: 'usr_b' });

    // Same user id, wrong tenant: this is the leak the rule exists to prevent.
    await expect(users.findById('tnt_a', 'usr_b')).resolves.toBeNull();
    await expect(users.findById('tnt_b', 'usr_a')).resolves.toBeNull();
  });

  it('updateName cannot write across a tenant boundary', async () => {
    const fake = seedTwoTenants();
    const users = new UserRepository(fake.client);

    const updated = await users.updateName('tnt_a', 'usr_b', 'Renamed By Attacker');

    expect(updated).toBe(0);
    expect(fake.users.find((u) => u.id === 'usr_b')?.name).toBe('Bob');
  });

  it('updatePasswordAndBumpVersion cannot write across a tenant boundary', async () => {
    const fake = seedTwoTenants();
    const users = new UserRepository(fake.client);

    const updated = await users.updatePasswordAndBumpVersion('tnt_a', 'usr_b', 'attacker-hash');

    expect(updated).toBe(0);
    const victim = fake.users.find((u) => u.id === 'usr_b');
    expect(victim?.passwordHash).toBe('hash-b');
    // Critically: the victim's sessions must not have been invalidated either.
    expect(victim?.tokenVersion).toBe(0);
  });

  it('updatePasswordAndBumpVersion increments tokenVersion for the right tenant', async () => {
    const fake = seedTwoTenants();
    const users = new UserRepository(fake.client);

    const updated = await users.updatePasswordAndBumpVersion('tnt_b', 'usr_b', 'new-hash');

    expect(updated).toBe(1);
    expect(fake.users.find((u) => u.id === 'usr_b')?.tokenVersion).toBe(1);
    expect(fake.users.find((u) => u.id === 'usr_a')?.tokenVersion).toBe(0);
  });

  it('findByEmail is deliberately unscoped — the one documented exception', async () => {
    const fake = seedTwoTenants();
    const users = new UserRepository(fake.client);

    // Login has no tenant context yet: the tenant is derived *from* the user that
    // this lookup finds. That is why User.email is globally unique rather than
    // unique per tenant, and why this test asserts the exception explicitly rather
    // than leaving it to be discovered by surprise.
    const ada = await users.findByEmail('ada@example.com');
    expect(ada?.id).toBe('usr_a');
    expect(ada?.tenant.name).toBe('Tenant A');

    await expect(users.findByEmail('nobody@example.com')).resolves.toBeNull();
  });

  it('createWithOwner gives the new user the new tenant', async () => {
    const fake = createFakeDb();
    const tenants = new TenantRepository(fake.client);

    const { tenant, user } = await tenants.createWithOwner({
      tenantName: 'Acme',
      email: 'ada@example.com',
      passwordHash: 'hash',
      userName: 'Ada',
    });

    expect(user.tenantId).toBe(tenant.id);
    expect(fake.users).toHaveLength(1);
    expect(fake.tenants).toHaveLength(1);
  });
});
