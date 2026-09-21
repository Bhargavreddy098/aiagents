/**
 * Surface contracts: channels, DM pairing, paired devices, the routing table and plugins.
 *
 * This is UI/UX v2 §5 — the half of the product that is *not* the Control UI. NEXS's
 * gateway is one control plane, and a Telegram DM, a paired CLI, the web Control UI and a
 * scheduled digest are all **surfaces** onto it. These contracts live here for the same
 * reason the control plane's do: the service layer, the repositories, the channel adapters
 * and the HTTP boundary must agree, and a policy that cannot legally be selected should be
 * rejected at the boundary rather than discovered in the database later.
 *
 * Four properties are structural rather than conventional:
 *
 *  1. **Every status is a state machine.** `PAIRING_TRANSITIONS` and `DEVICE_TRANSITIONS`
 *     are the same source of truth as their status lists, exactly as `AGENT_TRANSITIONS`
 *     is for agents.
 *  2. **The pairing code alphabet excludes ambiguous glyphs**, and is declared here rather
 *     than in the service because the Control UI, the CLI and the channel all render the
 *     same code — a second alphabet is how one of them starts printing an `O`.
 *  3. **Scopes are derived from an access level by one function.** `deviceScopesFor('full')`
 *     is the only place "Full access" means anything; a second copy of that list is how
 *     "Limited access" silently gains `operator.admin`.
 *  4. **Binding specificity is a property of the match key**, not a comparison over
 *     nullable columns — see `bindingMatchKey` for why the column-wise version is unsound.
 */

// ── channels ─────────────────────────────────────────────────────────────────

/**
 * The channel types the built-in adapters cover.
 *
 * Advisory, not exhaustive: a `channel` plugin may add one, so `Channel.type` is stored as
 * a plain string. Validating a *new* channel against this list is the service's job, which
 * lets this list grow without a migration while the column stays open.
 */
export const CHANNEL_TYPES = [
  'telegram',
  'discord',
  'slack',
  'whatsapp',
  'imessage',
  'teams',
  'signal',
  'matrix',
  'mattermost',
  'email',
  'sms',
  'googlechat',
] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];

/**
 * `unverified` is a real status, not a starting point waiting to be overwritten.
 *
 * A channel that is `healthy` because its last poll succeeded and a channel that is
 * `healthy` because nothing has ever contacted it are indistinguishable from the database,
 * and an operator staring at a green dot that has never been tested deserves better.
 * `unverified` means exactly "no successful contact yet".
 */
export const CHANNEL_STATUSES = [
  'unverified',
  'healthy',
  'degraded',
  'error',
  'disconnected',
] as const;

export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/** The only status whose dot renders `ok`. Everything else is waiting or failed. */
export function isChannelConnected(status: ChannelStatus): boolean {
  return status === 'healthy';
}

/**
 * How a DM from an unknown sender is handled.
 *
 * `open` is the one setting here that *removes* a gate rather than moving it, which is why
 * §5.2 requires the account's allowlist to contain `*` before it may be selected — the two
 * fields must not be allowed to contradict each other.
 */
export const DM_POLICIES = ['open', 'allowlist', 'pairing'] as const;

export type DmPolicy = (typeof DM_POLICIES)[number];

export const GROUP_POLICIES = ['open', 'allowlist', 'disabled'] as const;

export type GroupPolicy = (typeof GROUP_POLICIES)[number];

// ── access groups ────────────────────────────────────────────────────────────

export const ACCESS_GROUP_TYPES = ['message.senders'] as const;

export type AccessGroupType = (typeof ACCESS_GROUP_TYPES)[number];

/**
 * An allowlist entry that starts with this is an *indirection* rather than a literal
 * sender id, so one trusted set can be referenced from every channel, DM list and group
 * list without being copied into each of them.
 */
export const ACCESS_GROUP_REF_PREFIX = 'accessGroup:';

export function accessGroupRef(name: string): string {
  return `${ACCESS_GROUP_REF_PREFIX}${name}`;
}

/**
 * The group name an allowlist entry refers to, or `null` when the entry is a literal
 * sender id. A bare `"accessGroup:"` is malformed and returns `null` rather than `""`, so
 * a caller cannot look up a group whose name is empty.
 */
export function accessGroupNameFrom(token: string): string | null {
  if (!token.startsWith(ACCESS_GROUP_REF_PREFIX)) return null;
  const name = token.slice(ACCESS_GROUP_REF_PREFIX.length);
  return name.length === 0 ? null : name;
}

// ── DM pairing ───────────────────────────────────────────────────────────────

export const PAIRING_STATUSES = ['pending', 'approved', 'dismissed', 'expired'] as const;

export type PairingStatus = (typeof PAIRING_STATUSES)[number];

/**
 * The legal pairing transitions.
 *
 * All three terminal states have empty lists. `dismissed` is deliberately **not** a block:
 * the requester may ask again, which writes a *new* request rather than reopening this one.
 * A request is a record of an ask, and a record that can be reopened is not a record.
 *
 * `expired` is reachable only from `pending`, which makes "a decision beats the clock" true
 * by construction — the mirror of `APPROVAL_TRANSITIONS`, for the same reason.
 */
export const PAIRING_TRANSITIONS: Readonly<Record<PairingStatus, readonly PairingStatus[]>> = {
  pending: ['approved', 'dismissed', 'expired'],
  approved: [],
  dismissed: [],
  expired: [],
};

export function isTerminalPairingStatus(status: PairingStatus): boolean {
  return PAIRING_TRANSITIONS[status].length === 0;
}

export function canTransitionPairing(from: PairingStatus, to: PairingStatus): boolean {
  return PAIRING_TRANSITIONS[from].includes(to);
}

/**
 * No `I`, `O`, `0` or `1`.
 *
 * A pairing code is read off one screen and typed into another, and those four glyphs are
 * the pairs people get wrong. Excluding them costs nothing — the alphabet still yields
 * 32^8 ≈ 1.1e12 codes at length 8 — and removes the failure mode where a correct code is
 * rejected as unknown.
 */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const PAIRING_CODE_LENGTH = 8;

/** One hour, per §5.3 — long enough to relay by hand, short enough not to linger. */
export const PAIRING_TTL_MS = 60 * 60 * 1000;

/** At most this many pending requests per channel account, per §5.3. */
export const PAIRING_MAX_PENDING_PER_ACCOUNT = 3;

// ── devices ──────────────────────────────────────────────────────────────────

/**
 * What a paired client *is*. `webchat` is the Control UI in a browser tab and `operator` is
 * a CLI or TUI; both speak the operator API, which is why they share the operator scopes.
 */
export const DEVICE_ROLES = ['node', 'operator', 'browser', 'webchat'] as const;

export type DeviceRole = (typeof DEVICE_ROLES)[number];

export const DEVICE_ACCESS_LEVELS = ['full', 'limited'] as const;

export type DeviceAccess = (typeof DEVICE_ACCESS_LEVELS)[number];

export const DEVICE_STATUSES = ['pending', 'paired', 'revoked'] as const;

export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/**
 * The legal device transitions.
 *
 * The important one is **absent**: there is no `paired → pending`. Widening a device's
 * scopes is a *new* pending request, not an edit to a paired device — otherwise a device
 * could go from Limited to Full between two heartbeats and the operator would never have
 * been asked. Revoking a device is the only way back to `pending`, and it is a deliberate
 * act that also kills its tokens.
 */
export const DEVICE_TRANSITIONS: Readonly<Record<DeviceStatus, readonly DeviceStatus[]>> = {
  pending: ['paired', 'revoked'],
  paired: ['revoked'],
  revoked: [],
};

export function isTerminalDeviceStatus(status: DeviceStatus): boolean {
  return DEVICE_TRANSITIONS[status].length === 0;
}

export function canTransitionDevice(from: DeviceStatus, to: DeviceStatus): boolean {
  return DEVICE_TRANSITIONS[from].includes(to);
}

/** A device that may actually talk to the gateway. `pending` may not, which is the point. */
export function isDeviceUsable(status: DeviceStatus): boolean {
  return status === 'paired';
}

export const DEVICE_SCOPES = [
  'operator.admin',
  'operator.approvals',
  'operator.read',
  'operator.write',
  'operator.talk.secrets',
  'node',
] as const;

export type DeviceScope = (typeof DEVICE_SCOPES)[number];

/**
 * The scopes an access level grants — **the** definition of "Full access".
 *
 * `limited` is the same set minus `operator.admin`, not a different set: a limited CLI can
 * still read state, approve a parked run and talk to secrets, and what it cannot do is
 * change the gateway's own configuration. Deriving one from the other is what keeps that
 * statement true as the scope list grows.
 */
export function deviceScopesFor(access: DeviceAccess): DeviceScope[] {
  return access === 'full'
    ? [...DEVICE_SCOPES]
    : DEVICE_SCOPES.filter((scope) => scope !== 'operator.admin');
}

export function deviceHasScope(scopes: readonly string[], scope: DeviceScope): boolean {
  return scopes.includes(scope);
}

/**
 * Ten minutes, per §5.4. Short because the setup code carries a single-use bootstrap token
 * — the copy tells the operator to treat it like a password, and this is what makes that
 * advice meaningful rather than decorative.
 */
export const SETUP_CODE_TTL_MS = 10 * 60 * 1000;

// ─ bindings (multi-agent routing) ───────────────────────────────────────────

/** The placeholder for a route part the operator left open: "any". */
export const BINDING_WILDCARD = '*';

export interface BindingParts {
  channelType?: string | null;
  accountId?: string | null;
  peerId?: string | null;
}

function bindingPart(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? BINDING_WILDCARD : value;
}

/**
 * The canonical match key for a route: its three parts, `*` for any left open.
 *
 * This exists because `Binding` needs a **real unique constraint** and every part of a
 * route is optional. Postgres treats each `NULL` in a unique index as distinct, so
 * `@@unique([tenantId, channelType, accountId, peerId])` would happily store two identical
 * "any channel, any peer" rows — and then "most specific wins" would be undefined, because
 * two rows would claim the same match. Normalising into one non-null column makes the
 * constraint real *and* makes specificity countable, which is exactly what
 * `bindingSpecificity` does.
 */
export function bindingMatchKey(parts: BindingParts): string {
  return [bindingPart(parts.channelType), bindingPart(parts.accountId), bindingPart(parts.peerId)].join(
    '|',
  );
}

/**
 * How specific a match key is: the count of parts that are not a wildcard.
 *
 * `telegram|acct_1|peer_9` → 3, `telegram|acct_1|*` → 2, `telegram|*|*` → 1, `*|*|*` → 0.
 * Higher wins. Two distinct keys can never tie, because the count of non-wildcards is
 * determined by the key itself.
 */
export function bindingSpecificity(matchKey: string): number {
  return matchKey.split('|').filter((part) => part !== BINDING_WILDCARD).length;
}

/**
 * The keys a given peer presents, **most specific first** — the order a resolver tries.
 *
 * Deduplicated, because a peer with no account and no channel produces three identical
 * keys and asking the database for the same row three times is noise that then has to be
 * explained to whoever reads the query log.
 */
export function bindingMatchOrder(parts: BindingParts): string[] {
  const keys = [
    bindingMatchKey(parts),
    bindingMatchKey({ channelType: parts.channelType, accountId: parts.accountId }),
    bindingMatchKey({ channelType: parts.channelType }),
    bindingMatchKey({}),
  ];
  return [...new Set(keys)];
}

// ── plugins ──────────────────────────────────────────────────────────────────

/**
 * What a plugin contributes. `device-pair` is the one worth naming: it is what lets a
 * surface with no web session serve the `/pair` flow, which is the difference between
 * "pairing works in the Control UI" and "pairing works".
 */
export const PLUGIN_KINDS = ['channel', 'transport', 'capability', 'device-pair'] as const;

export type PluginKind = (typeof PLUGIN_KINDS)[number];

export const PLUGIN_STATUSES = ['installed', 'enabled', 'error'] as const;

export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

/** `installed` and `enabled` are different states: installed is present, enabled is acting. */
export function isPluginActive(enabled: boolean, status: PluginStatus): boolean {
  return enabled && status === 'enabled';
}

// ── cross-surface identifiers ───────────────────────────────────────────────

/**
 * Where a conversation can be live: the Control UI, or any channel.
 *
 * `web` is a member because the Control UI is itself a surface — the whole point of §2.3's
 * strip is that web and Telegram appear side by side, neither privileged.
 */
export const SURFACE_IDS = ['web', ...CHANNEL_TYPES] as const;

export type SurfaceId = (typeof SURFACE_IDS)[number];

/**
 * The **kinds** of client that can run a command — deliberately not a `SurfaceId`.
 *
 * A `SurfaceId` names one concrete place ("telegram", "web"). But a command's availability is
 * a property of the *client class*, not of the channel: the Control UI, a CLI and a TUI are
 * three different surfaces that all speak the operator API and can therefore run exactly the
 * same commands, whereas a channel's menu is generated from that same registry but may
 * legitimately be narrower (§9). Collapsing the two vocabularies would mean declaring a
 * command available "on Telegram, Discord, Slack, Signal, Matrix, …" instead of "on a channel",
 * which is a list that goes stale the moment a plugin adds a channel type.
 */
export const COMMAND_SURFACES = ['web', 'cli', 'tui', 'channel'] as const;

export type CommandSurface = (typeof COMMAND_SURFACES)[number];

/** Every client class. The usual answer, so it has a name. */
export const ALL_COMMAND_SURFACES: readonly CommandSurface[] = COMMAND_SURFACES;

/**
 * Commands a non-admin may always run, whatever a channel's `userAllowedCommands` says.
 *
 * §5.2 states this as a floor rather than a default: an account may *widen* the set of
 * commands its regular users get, never narrow it below these. Without them a restricted
 * account would leave its users unable to discover or identify anything — `/help` is how you
 * find out what you may run, and `/whoami` is how you find out who the gateway thinks you are.
 */
export const ALWAYS_ALLOWED_COMMANDS = ['help', 'whoami'] as const;

export type AlwaysAllowedCommand = (typeof ALWAYS_ALLOWED_COMMANDS)[number];

/**
 * Where a fired schedule posts its output.
 *
 * `peerRef` is the destination *within* the channel — a DM recipient, a Discord channel id,
 * a Telegram topic — and is deliberately a string the adapter interprets rather than a
 * typed union, because each channel's addressing scheme is its own.
 */
export interface DeliveryTarget {
  channelType: string;
  accountId?: string | null;
  peerRef?: string | null;
}

// ── exec approvals (an approval's second kind) ──────────────────────────────

/**
 * An approval is raised by two different things, and an operator needs to know which.
 *
 * `tool` is the plan-step gate the engine has always had: a risky step parks and waits.
 * `exec` is an **owner-only command** — the operator's own shell, not the agent's — and its
 * answers are different in kind: "allow always" writes an allowlist rule rather than
 * deciding one command. Collapsing them into one kind would mean the Decision Inbox offered
 * "Allow always" on step 3 of a plan.
 */
export const APPROVAL_KINDS = ['tool', 'exec'] as const;

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** The answers an `exec` approval accepts. `tool` approvals take approve/reject instead. */
export const EXEC_DECISION_OPTIONS = ['allow_once', 'allow_always', 'deny'] as const;

export type ExecDecisionOption = (typeof EXEC_DECISION_OPTIONS)[number];

/**
 * A command awaiting the owner's permission.
 *
 * `cwd` is part of it because `npm test` in two different repositories is two different
 * actions, and an approval that omitted the directory would be asking the operator to
 * authorise a command they cannot actually see.
 */
export interface ExecRequestedAction {
  command: string;
  args: string[];
  cwd: string;
}

// ─ channel wire shapes ─────────────────────────────────────────────────────

export interface ChannelAccountSummary {
  id: string;
  label: string;
  status: ChannelStatus;
  credentialId: string | null;
  /** Literal sender ids and `accessGroup:<name>` references, exactly as stored. */
  allowFrom: string[];
  groupAllowFrom: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Which commands a non-admin may run on this account.
 *
 * Unset is the honest default and means "unrestricted" — the config keys are absent, not
 * empty, because an empty list would read as "nobody may run anything" and `/help` is
 * always permitted. §5.2 requires the UI to say so rather than show an empty box.
 */
export interface ChannelCommandPolicy {
  allowAdminFrom: string[];
  /** `null` means unrestricted. An array is a floor; `/help` and `/whoami` are always in it. */
  userAllowedCommands: string[] | null;
}

export interface ChannelSummary {
  id: string;
  type: string;
  name: string;
  status: ChannelStatus;
  /** The last failure, verbatim. A status with no reason is unactionable. */
  statusDetail: string | null;
  dmPolicy: DmPolicy;
  groupPolicy: GroupPolicy;
  deliveryDefault: string | null;
  voiceEnabled: boolean;
  accountCount: number;
  /** Pending DM pairing requests across this channel's accounts — traced to rows. */
  pendingPairings: number;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelDetail extends ChannelSummary {
  accounts: ChannelAccountSummary[];
  commandPolicy: ChannelCommandPolicy;
  metadata: unknown;
}

export interface AccessGroupSummary {
  id: string;
  name: string;
  type: string;
  members: string[];
  createdAt: string;
  updatedAt: string;
}

// ─ pairing wire shapes ─────────────────────────────────────────────────────

export interface PairingRequestSummary {
  id: string;
  channelType: string;
  accountId: string | null;
  senderId: string;
  /** The 8-character code, rendered mono on every surface that shows it. */
  code: string;
  status: PairingStatus;
  /** `pending` and past `expiresAt` as of the moment the response was built. */
  isExpired: boolean;
  expiresAt: string;
  notifyOnApprove: boolean;
  madeOwner: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  metadata: unknown;
}

/**
 * The pairing queue, with per-account occupancy alongside it.
 *
 * The counts travel with the list for the same reason the unread count travels with the
 * notification list: the cap indicator and the queue are always rendered together, and two
 * fetches would let the badge say "3 of 3" while the queue shows two.
 */
export interface PairingQueue {
  requests: PairingRequestSummary[];
  countByAccount: Record<string, number>;
}

export interface ApprovePairingResult {
  request: PairingRequestSummary;
  /** Whether this approval *also* made the sender the command owner (§5.3). */
  ownerGranted: boolean;
}

// ─ device wire shapes ─────────────────────────────────────────────────────

export interface DeviceSummary {
  id: string;
  role: DeviceRole;
  name: string;
  access: DeviceAccess;
  scopes: string[];
  status: DeviceStatus;
  lastSeenAt: string | null;
  /** Live tokens: not revoked, not used, not expired. A count, never a list of hashes. */
  activeTokenCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A setup code — what the operator shows the new device.
 *
 * `code` is both the copyable text and the payload a QR renderer encodes, and it carries a
 * single-use bootstrap token. Text is a first-class form rather than a fallback: an
 * image-only setup code is unusable to a screen reader and to a headless CLI, which §17
 * lists as a hard rule.
 */
export interface DeviceSetupCode {
  deviceId: string;
  code: string;
  expiresAt: string;
  access: DeviceAccess;
  scopes: string[];
  /** The gateway URL(s) the device should call, so the code is self-contained. */
  gatewayUrls: string[];
}

// ─ binding wire shapes ─────────────────────────────────────────────────────

export interface BindingSummary {
  id: string;
  channelType: string | null;
  accountId: string | null;
  peerId: string | null;
  matchKey: string;
  /** Non-wildcard parts of `matchKey`. Precomputed because the UI sorts by it. */
  specificity: number;
  agentId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The answer to "which agent answers this peer?".
 *
 * A resolution names the winning row rather than only the agent, because "Test routing"
 * exists to answer *why* an agent answered — a bare `agentId` would leave the operator
 * unable to tell a specific rule from the catch-all.
 */
export interface BindingResolution {
  agentId: string;
  matchKey: string;
  specificity: number;
}

// ─ plugin & skills-hub wire shapes ─────────────────────────────────────────

export interface PluginSummary {
  id: string;
  name: string;
  kind: PluginKind;
  version: string;
  source: string;
  enabled: boolean;
  status: PluginStatus;
  active: boolean;
  /** May this plugin add channel types? Derived from `kind`, not stored twice. */
  addsChannels: boolean;
  /** May this plugin serve the device pairing flow? Derived from `kind`. */
  supportsPairing: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillHubEntrySummary {
  slug: string;
  latestVersion: string;
  description: string | null;
  sourceUrl: string | null;
  cachedAt: string;
}

// ── exec approvals (§4.4, §11) ───────────────────────────────────────────────

/**
 * Which terminal `Approval.status` a fine-grained answer produces.
 *
 * `allow_once` and `allow_always` both *approve* — what differs is the durable consequence,
 * not the decision. Keeping that mapping in one function is what stops a second call site
 * from deciding that `allow_always` is somehow "more approved".
 */
export function execDecisionToStatus(decision: ExecDecisionOption): 'approved' | 'rejected' {
  return decision === 'deny' ? 'rejected' : 'approved';
}

/**
 * Does a standing rule authorise this request?
 *
 * **The only implementation of the matching rule**, and the rule is: `command` and `cwd` must
 * match exactly, and the requested args must begin with the stored args — compared
 * **element-wise**, never as a substring. A rule granted for `['test']` therefore authorises
 * `['test','--watch']`, and refuses both `['publish']` and `['test-evil']`.
 *
 * Element-wise is the load-bearing part. A prefix match on a joined string would make `test`
 * authorise `test-evil`, which is exactly the hole that makes command allowlists dangerous,
 * and it is invisible in review because the string "looks" like it matches.
 */
export function execCommandMatches(
  rule: { command: string; args: readonly string[]; cwd: string },
  request: ExecRequestedAction,
): boolean {
  if (rule.command !== request.command) return false;
  if (rule.cwd !== request.cwd) return false;
  // A rule with more args than the request can never be satisfied: `['test','--ci']` does not
  // authorise a bare `npm test`.
  if (request.args.length < rule.args.length) return false;
  return rule.args.every((arg, index) => request.args[index] === arg);
}

/**
 * Is this rule currently live?
 *
 * **Revoked wins over everything.** A revoked rule stays revoked even if its expiry is in the
 * future, because revocation is a deliberate act and expiry is only the clock running out —
 * and an operator who revoked a permission must not have to wait for it to lapse.
 *
 * Accepts `Date | string` because a repository row carries `Date`s and a mapped wire shape
 * carries ISO strings, and both are legitimately "the same rule". Normalising here is cheaper
 * than teaching every caller which one it holds.
 */
export function isExecRuleActive(
  rule: { revokedAt: Date | string | null; expiresAt: Date | string | null },
  now: Date,
): boolean {
  if (rule.revokedAt !== null) return false;
  if (rule.expiresAt === null) return true;
  const expires = rule.expiresAt instanceof Date ? rule.expiresAt : new Date(rule.expiresAt);
  return expires.getTime() > now.getTime();
}

/**
 * A standing exec permission as the wire sees it.
 *
 * `isActive` is **derived** from `revokedAt`/`expiresAt` rather than stored, so it cannot
 * disagree with them — and it is shipped because the UI's job is to show a live-looking rule
 * greyed out rather than to render a Revoke button that will fail.
 */
export interface ExecAllowlistRuleSummary {
  id: string;
  agentId: string | null;
  command: string;
  args: string[];
  cwd: string;
  createdBy: string;
  isActive: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}