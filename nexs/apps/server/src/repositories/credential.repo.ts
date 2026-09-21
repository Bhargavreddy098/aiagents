import type { Credential, PrismaClient } from '@prisma/client';

export class CredentialRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: {
    tenantId: string;
    label: string;
    kind: string;
    encrypted: string;
    keyPrefix: string;
  }): Promise<Credential> {
    return this.db.credential.create({ data });
  }

  /** Tenant-scoped: the first argument is the tenant, and it is always in the where. */
  async findById(tenantId: string, id: string): Promise<Credential | null> {
    return this.db.credential.findFirst({ where: { id, tenantId } });
  }

  async list(tenantId: string): Promise<Credential[]> {
    return this.db.credential.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
  }

  /** Re-encrypt in place after a key change; never returns the plaintext. */
  async replaceCiphertext(
    tenantId: string,
    id: string,
    encrypted: string,
    keyPrefix: string,
  ): Promise<number> {
    const { count } = await this.db.credential.updateMany({
      where: { id, tenantId },
      data: { encrypted, keyPrefix, rotatedAt: new Date() },
    });
    return count;
  }

  async delete(tenantId: string, id: string): Promise<number> {
    const { count } = await this.db.credential.deleteMany({ where: { id, tenantId } });
    return count;
  }
}
