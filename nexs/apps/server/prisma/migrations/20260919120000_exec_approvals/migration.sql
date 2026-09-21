-- Exec approvals (UI/UX v2 S4.4, S11): the owner-only command gate.
--
-- Generated offline from the schema delta, never by hand:
--   prisma migrate diff --from-schema-datamodel <before>.prisma --to-schema-datamodel prisma/schema.prisma --script
--
-- All three changes are additive and safe against a database holding rows: an unowned
-- tenant can grant nothing (which is what it could do before), every existing approval is a
-- tool gate with no fine-grained decision, and the new table starts empty.
-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "ownerUserId" TEXT;

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "decision" TEXT;

-- CreateTable
CREATE TABLE "ExecAllowlistRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT,
    "command" TEXT NOT NULL,
    "args" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cwd" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecAllowlistRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecAllowlistRule_tenantId_command_cwd_idx" ON "ExecAllowlistRule"("tenantId", "command", "cwd");

-- CreateIndex
CREATE INDEX "ExecAllowlistRule_tenantId_agentId_idx" ON "ExecAllowlistRule"("tenantId", "agentId");
