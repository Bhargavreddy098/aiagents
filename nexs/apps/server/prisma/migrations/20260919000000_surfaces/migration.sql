-- Surfaces (UI/UX v2 S5, S20): channels, DM pairing, devices, bindings, plugins.
--
-- Generated offline from the schema delta, never by hand:
--   prisma migrate diff --from-schema-datamodel <before>.prisma --to-schema-datamodel prisma/schema.prisma --script
--
-- The three ALTER TABLEs are additive and nullable-or-defaulted, so they can be applied to a
-- database that already holds rows: every existing Schedule keeps delivering nowhere (which is
-- what it did), every existing Approval is a tool gate, and every existing ChatSession started
-- on web.
-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "deliveryTarget" JSONB;

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'tool';

-- AlterTable
ALTER TABLE "ChatSession" ADD COLUMN     "channelType" TEXT,
ADD COLUMN     "peerRef" TEXT,
ADD COLUMN     "surface" TEXT NOT NULL DEFAULT 'web';

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "statusDetail" TEXT,
    "dmPolicy" TEXT NOT NULL DEFAULT 'pairing',
    "groupPolicy" TEXT NOT NULL DEFAULT 'allowlist',
    "deliveryDefault" TEXT,
    "voiceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "credentialId" TEXT,
    "allowFrom" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "groupAllowFrom" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'message.senders',
    "members" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PairingRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelType" TEXT NOT NULL,
    "accountId" TEXT,
    "senderId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "notifyOnApprove" BOOLEAN NOT NULL DEFAULT false,
    "madeOwner" BOOLEAN NOT NULL DEFAULT false,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'limited',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publicKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Binding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelType" TEXT,
    "accountId" TEXT,
    "peerId" TEXT,
    "matchKey" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Binding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plugin" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'bundled',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'installed',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plugin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillHubEntry" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "latestVersion" TEXT NOT NULL,
    "description" TEXT,
    "readme" TEXT,
    "sourceUrl" TEXT,
    "cachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillHubEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Channel_tenantId_status_idx" ON "Channel"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_tenantId_type_name_key" ON "Channel"("tenantId", "type", "name");

-- CreateIndex
CREATE INDEX "ChannelAccount_tenantId_idx" ON "ChannelAccount"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAccount_channelId_label_key" ON "ChannelAccount"("channelId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "AccessGroup_tenantId_name_key" ON "AccessGroup"("tenantId", "name");

-- CreateIndex
CREATE INDEX "PairingRequest_tenantId_status_idx" ON "PairingRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PairingRequest_accountId_status_idx" ON "PairingRequest"("accountId", "status");

-- CreateIndex
CREATE INDEX "PairingRequest_tenantId_channelType_senderId_status_idx" ON "PairingRequest"("tenantId", "channelType", "senderId", "status");

-- CreateIndex
CREATE INDEX "Device_tenantId_status_idx" ON "Device"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_tokenHash_key" ON "DeviceToken"("tokenHash");

-- CreateIndex
CREATE INDEX "DeviceToken_deviceId_idx" ON "DeviceToken"("deviceId");

-- CreateIndex
CREATE INDEX "Binding_tenantId_idx" ON "Binding"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Binding_tenantId_matchKey_key" ON "Binding"("tenantId", "matchKey");

-- CreateIndex
CREATE UNIQUE INDEX "Plugin_tenantId_name_key" ON "Plugin"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SkillHubEntry_slug_key" ON "SkillHubEntry"("slug");

-- AddForeignKey
ALTER TABLE "ChannelAccount" ADD CONSTRAINT "ChannelAccount_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

