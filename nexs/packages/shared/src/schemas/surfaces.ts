import { z } from 'zod';
import {
  ACCESS_GROUP_TYPES,
  CHANNEL_STATUSES,
  DEVICE_ACCESS_LEVELS,
  DEVICE_ROLES,
  DM_POLICIES,
  EXEC_DECISION_OPTIONS,
  GROUP_POLICIES,
  PAIRING_STATUSES,
  PLUGIN_KINDS,
  PLUGIN_STATUSES,
} from '../types/surfaces.js';

/**
 * Surface input schemas.
 *
 * The same two conventions every other schema file here follows, for the same reasons:
 *
 *  1. **Every schema is `.strict()`.** On these endpoints a dropped key is a security
 *     setting that silently did not apply — `dmPolicy` misspelled would leave the channel on
 *     its default policy while the operator believed they had closed it. `.strict()` turns
 *     that into an error naming the key.
 *  2. **Nothing is `.default()`-ed.** A default applied at the boundary is a value the
 *     caller never sent being written to a row; defaults belong where the row is created, so
 *     the schema's job stays "is this well-formed?".
 *
 * One shape deserves its own note: **`updateBindingSchema` accepts only `agentId`.** A
 * binding's *route* is its identity (`matchKey` is the unique column), so retargeting a rule
 * and moving it are different operations — retargeting is a `PATCH`, moving it is a delete
 * plus a create. Letting the parts be edited would allow two concurrent edits to collide on
 * one `matchKey` and surface as a `P2002` rather than as a decision.
 */

const id = z.string().trim().min(1);
const idList = z.array(id).max(500);

/** Stored verbatim, never traversed — `z.unknown()` rather than `z.any()`. */
const jsonObject = z.record(z.string(), z.unknown());

/**
 * Which commands a non-admin may run. Shared by create and update so the two can never
 * disagree about what the policy is.
 */
const commandPolicy = z
  .object({
    allowAdminFrom: idList,
    userAllowedCommands: z.array(z.string().trim().min(1)).max(500).nullable(),
  })
  .strict();

// ── channels ─────────────────────────────────────────────────────────────────

export const createChannelSchema = z
  .object({
    /**
     * Any non-empty string, deliberately **not** `z.enum(CHANNEL_TYPES)`: a `channel` plugin
     * may register a type this build has never heard of, and refusing it here would make
     * plugins impossible. The service validates against the plugin registry.
     */
    type: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(200),
    dmPolicy: z.enum(DM_POLICIES).optional(),
    groupPolicy: z.enum(GROUP_POLICIES).optional(),
    voiceEnabled: z.boolean().optional(),
    commandPolicy: commandPolicy.optional(),
    metadata: jsonObject.optional(),
  })
  .strict();

export const updateChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(CHANNEL_STATUSES).optional(),
    statusDetail: z.string().trim().max(2000).nullable().optional(),
    dmPolicy: z.enum(DM_POLICIES).optional(),
    groupPolicy: z.enum(GROUP_POLICIES).optional(),
    voiceEnabled: z.boolean().optional(),
    /** `null` clears the default routing; it does not fall back to "first account". */
    deliveryDefault: id.nullable().optional(),
    commandPolicy: commandPolicy.optional(),
    metadata: jsonObject.optional(),
  })
  .strict();

export const listChannelsSchema = z
  .object({
    type: z.string().trim().min(1).max(64).optional(),
    status: z.enum(CHANNEL_STATUSES).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

export const createChannelAccountSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    credentialId: id.nullable().optional(),
    /**
     * Literal sender ids and `accessGroup:<name>` references. `"*"` is permitted, and it is
     * what makes `dmPolicy: "open"` selectable — the service enforces that pairing rather
     * than the schema, because "is `*` present?" is a question about the whole array.
     */
    allowFrom: z.array(z.string().trim().min(1).max(200)).max(1000).optional(),
    groupAllowFrom: z.array(z.string().trim().min(1).max(200)).max(1000).optional(),
    metadata: jsonObject.optional(),
  })
  .strict();

export const updateChannelAccountSchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    credentialId: id.nullable().optional(),
    allowFrom: z.array(z.string().trim().min(1).max(200)).max(1000).optional(),
    groupAllowFrom: z.array(z.string().trim().min(1).max(200)).max(1000).optional(),
    status: z.enum(CHANNEL_STATUSES).optional(),
    metadata: jsonObject.optional(),
  })
  .strict();

// ── inferred input types (channels) ─────────────────────────────────────────

export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;
export type ListChannelsQuery = z.infer<typeof listChannelsSchema>;
export type CreateChannelAccountInput = z.infer<typeof createChannelAccountSchema>;
export type UpdateChannelAccountInput = z.infer<typeof updateChannelAccountSchema>;

// ── access groups ────────────────────────────────────────────────────────────

/**
 * A group name is interpolated into `accessGroup:<name>` and matched against allowlist
 * entries, so it excludes the syntax of both: no `|` (which separates match-key parts) and
 * no `*` (which means "any"). A name containing either would make a reference ambiguous.
 */
const groupName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'A group name may contain letters, digits, dot, dash and underscore');

export const createAccessGroupSchema = z
  .object({
    name: groupName,
    type: z.enum(ACCESS_GROUP_TYPES).optional(),
    members: z.array(z.string().trim().min(1).max(200)).max(2000),
  })
  .strict();

export const updateAccessGroupSchema = z
  .object({
    name: groupName.optional(),
    members: z.array(z.string().trim().min(1).max(200)).max(2000).optional(),
  })
  .strict();

// ── pairing ─────────────────────────────────────────────────────────────────

/**
 * An inbound DM asking to be let in.
 *
 * `senderId` is the channel's own identifier for the person and is supplied by the adapter,
 * never by the requester: a request that let the sender name themselves would let one
 * person claim another's approved identity.
 */
export const createPairingRequestSchema = z
  .object({
    channelType: z.string().trim().min(1).max(64),
    accountId: id.nullable().optional(),
    senderId: z.string().trim().min(1).max(256),
    metadata: jsonObject.optional(),
  })
  .strict();

/**
 * An operator's decision on a pending request.
 *
 * `makeOwner` is a flag rather than an inference from "no owner exists yet", because making
 * someone the command owner is a privileged act that §5.3 says must be *chosen* — and it is
 * refused, not silently ignored, when the caller lacks the authority or an owner exists.
 */
export const approvePairingSchema = z
  .object({
    notifyOnApprove: z.boolean().optional(),
    makeOwner: z.boolean().optional(),
  })
  .strict();

export const dismissPairingSchema = z
  .object({
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

export const listPairingSchema = z
  .object({
    status: z.enum(PAIRING_STATUSES).optional(),
    channelType: z.string().trim().min(1).max(64).optional(),
    accountId: id.optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

/**
 * The lookup by code — what a requester's `/pair <code>` and the CLI's
 * `nexs pairing approve <channel> <CODE>` both resolve against.
 */
export const pairingCodeSchema = z
  .object({
    code: z.string().trim().min(1).max(32),
  })
  .strict();

export type CreateAccessGroupInput = z.infer<typeof createAccessGroupSchema>;
export type UpdateAccessGroupInput = z.infer<typeof updateAccessGroupSchema>;
export type CreatePairingRequestInput = z.infer<typeof createPairingRequestSchema>;
export type ApprovePairingInput = z.infer<typeof approvePairingSchema>;
export type DismissPairingInput = z.infer<typeof dismissPairingSchema>;
export type ListPairingQuery = z.infer<typeof listPairingSchema>;
export type PairingCodeInput = z.infer<typeof pairingCodeSchema>;

// ── devices ──────────────────────────────────────────────────────────────────

export const createDeviceSchema = z
  .object({
    role: z.enum(DEVICE_ROLES),
    name: z.string().trim().min(1).max(200),
    /**
     * Optional, and defaulted to `limited` **by the service**, not here. "Full access
     * (recommended)" is UI copy; the safe default belongs next to the row write, where it can
     * be read alongside the scope derivation it feeds.
     */
    access: z.enum(DEVICE_ACCESS_LEVELS).optional(),
    publicKey: z.string().trim().max(4000).optional(),
  })
  .strict();

export const updateDeviceSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/**
 * A request for a different access level.
 *
 * The level is required and must *differ* from the device's current one. Narrowing is a
 * legitimate request (it produces a fresh pending device with smaller scopes); restating the
 * current level is not a request at all, and the service refuses it rather than writing a
 * pending row that would "grant" what the device already has.
 */
export const requestDeviceUpgradeSchema = z
  .object({
    access: z.enum(DEVICE_ACCESS_LEVELS),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

export const listDevicesSchema = z
  .object({
    role: z.enum(DEVICE_ROLES).optional(),
    status: z.string().trim().min(1).max(32).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

// ── bindings ─────────────────────────────────────────────────────────────────

export const createBindingSchema = z
  .object({
    /** Omitted or `null` means "any" — stored as `*` in the match key, never as `NULL`. */
    channelType: z.string().trim().min(1).max(64).nullable().optional(),
    accountId: id.nullable().optional(),
    peerId: z.string().trim().min(1).max(256).nullable().optional(),
    agentId: id,
  })
  .strict();

/** Only the target may change — see the file header for why the route may not. */
export const updateBindingSchema = z
  .object({
    agentId: id,
  })
  .strict();

/** "Test routing": resolve who would answer, without sending anything anywhere. */
export const resolveBindingSchema = z
  .object({
    channelType: z.string().trim().min(1).max(64).optional(),
    accountId: id.optional(),
    peerId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;
export type RequestDeviceUpgradeInput = z.infer<typeof requestDeviceUpgradeSchema>;
export type ListDevicesQuery = z.infer<typeof listDevicesSchema>;
export type CreateBindingInput = z.infer<typeof createBindingSchema>;
export type UpdateBindingInput = z.infer<typeof updateBindingSchema>;
export type ResolveBindingQuery = z.infer<typeof resolveBindingSchema>;

// ── plugins ─────────────────────────────────────────────────────────────────

export const installPluginSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(
        /^[a-z0-9][a-z0-9._-]*$/,
        'A plugin name is lower-case: letters, digits, dot, dash, underscore',
      ),
    kind: z.enum(PLUGIN_KINDS),
    version: z.string().trim().min(1).max(64),
    source: z.enum(['bundled', 'external']).optional(),
    metadata: jsonObject.optional(),
  })
  .strict();

/**
 * Enable or disable a plugin.
 *
 * `enabled` is **required**, not optional: this endpoint's whole purpose is to flip one
 * boolean, and an absent key would be a no-op returning 200 — the caller would believe they
 * had enabled a plugin that is still off.
 */
export const updatePluginSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const listPluginsSchema = z
  .object({
    kind: z.enum(PLUGIN_KINDS).optional(),
    status: z.enum(PLUGIN_STATUSES).optional(),
    enabled: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

// ── skills hub & exec approvals ──────────────────────────────────────────────

export const listSkillHubSchema = z
  .object({
    /** Free-text match over slug and description. */
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/**
 * Install a catalog entry as a tenant-owned skill.
 *
 * `version` is optional and defaults to the entry's `latestVersion` — pinning is available
 * because a run's behaviour must be reproducible, but requiring it would turn the common case
 * ("install this") into two lookups.
 */
export const installSkillFromHubSchema = z
  .object({
    slug: z.string().trim().min(1).max(128),
    version: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/**
 * The owner's answer to an exec approval.
 *
 * Separate from `decideApprovalSchema` because the vocabularies differ in kind: a step is
 * approved or rejected, whereas a command may additionally be *always* allowed, which writes
 * an allowlist rule rather than deciding one invocation. One schema accepting both would let
 * `allow_always` reach a tool approval, where it means nothing.
 */
export const decideExecApprovalSchema = z
  .object({
    decision: z.enum(EXEC_DECISION_OPTIONS),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

export type InstallPluginInput = z.infer<typeof installPluginSchema>;
export type UpdatePluginInput = z.infer<typeof updatePluginSchema>;
export type ListPluginsQuery = z.infer<typeof listPluginsSchema>;
export type ListSkillHubQuery = z.infer<typeof listSkillHubSchema>;
export type InstallSkillFromHubInput = z.infer<typeof installSkillFromHubSchema>;
export type DecideExecApprovalInput = z.infer<typeof decideExecApprovalSchema>;

/**
 * Raising an exec approval: the gateway asking the owner whether an operator's command may run.
 *
 * `command`, `args` and `cwd` are supplied by the **caller that will run the command**, never
 * inferred here. That is the whole point of the payload: the approval must show the operator
 * exactly what will execute, and a server that guessed the argv would be asking for permission
 * to run something other than what it later runs.
 */
export const requestExecApprovalSchema = z
  .object({
    command: z.string().trim().min(1).max(512),
    args: z.array(z.string().max(2048)).max(64),
    cwd: z.string().trim().min(1).max(4096),
    /** What the run is for, shown to the owner. */
    description: z.string().trim().max(2000).optional(),
    /** Links the request to a run so the step can be failed or resumed with the answer. */
    runId: id.optional(),
    stepId: id.optional(),
    /** How long the request stands before it lapses. The service applies a default. */
    expiresInMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
  })
  .strict();

/** The standing permissions, filtered. Revoked and lapsed rules are excluded by default. */
export const listExecRulesSchema = z
  .object({
    agentId: id.optional(),
    includeInactive: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

/**
 * What the gateway asks before running a command that a rule might already cover.
 *
 * Same three fields as the approval request, because it is the same question asked in a
 * cheaper place: "is this already permitted?" rather than "may this be permitted?".
 */
export const checkExecSchema = z
  .object({
    command: z.string().trim().min(1).max(512),
    args: z.array(z.string().max(2048)).max(64),
    cwd: z.string().trim().min(1).max(4096),
    agentId: id.nullable().optional(),
  })
  .strict();

export type RequestExecApprovalInput = z.infer<typeof requestExecApprovalSchema>;
export type ListExecRulesQuery = z.infer<typeof listExecRulesSchema>;
export type CheckExecInput = z.infer<typeof checkExecSchema>;

/**
 * Claiming or transferring the command owner (§5.6).
 *
 * `ownerUserId: null` **clears** the owner, which is a deliberate operation and not an
 * accident, so it is an explicit union rather than `.optional()` — an omitted key would be
 * indistinguishable from "clear it", and clearing ownership disables the exec gate.
 *
 * When a tenant has **no** owner, any member may claim it: that is the bootstrap path §5.6
 * describes ("from first pairing bootstrap or set in Settings"), and a workspace where nobody
 * can ever become the owner is strictly worse than one where the first member can. Once an owner
 * exists, only that owner may transfer or clear it. The service enforces both halves and states
 * which one applied, because "you claimed it" and "you took it from someone" must not look the
 * same in a log.
 */
export const setOwnerSchema = z
  .object({
    ownerUserId: z.string().trim().min(1).nullable(),
  })
  .strict();

export type SetOwnerInput = z.infer<typeof setOwnerSchema>;

