import { ApiError, hasSideEffects } from '@nexs/shared';
import type {
  ConnectorAccountSummary,
  ConnectorDetail,
  ConnectorTestResult,
  CreateConnectorAccountInput,
  CreateConnectorInput,
  ListConnectorAccountsQuery,
  ListConnectorsQuery,
  UpdateConnectorInput,
} from '@nexs/shared';
import type { Connector, ConnectorAccount, Tool } from '@prisma/client';
import type { CredentialRepository } from '../../repositories/credential.repo.js';
import type { ConnectorAccountRepository, ConnectorRepository } from '../../repositories/connector.repo.js';
import type { ToolRepository } from '../../repositories/mcp.repo.js';
import type { Logger } from '../../logger.js';
import type { VaultService } from '../vault/vault.service.js';
import type { EngineEmitter } from '../engine/execution-engine.js';
import { createConnectorAdapter, hasConnectorAdapter, implementedConnectorTypes } from './adapters/index.js';
import { canonicalToolName, sameSet } from '../mcp/mcp-manager.js';
import {
  readConnectorConfig,
  toConnectorAccountSummary,
  toConnectorDetail,
  toConnectorTestResult,
} from '../../mappers/connectors.js';
import type {
  ConnectorAccountRef,
  ConnectorActionResult,
  ConnectorAdapter,
  ConnectorContext,
  DiscoveredCapability,
  FetchLike,
} from './types.js';

/**
 * `/api/connectors` — the door an operator uses to authorise a third-party service.
 *
 * ## The four rules this service enforces
 *
 * **1. A credential goes in once and never comes out.** `token` is accepted by `create`, `update`
 * and `addAccount`; nothing returns it. It is encrypted by the vault, stored as a `Credential` row,
 * and the connector keeps only the *id* of that row. Nothing in this file ever puts a token in a
 * response, an error message or a log line.
 *
 * **2. A connector type with no adapter is refused at creation.** `hasConnectorAdapter` is the
 * check. The schema knows the vocabulary of eight types; the registry knows which two are
 * implemented. Letting a `slack` connector through would create a row that lists, accepts a token,
 * and fails every call — and an operator would reasonably read that as "my token is wrong".
 *
 * **3. A probe failing is not a create failing.** `create` returns the row *and* the outcome of the
 * verification it ran. A vendor that is briefly unreachable must not leave the operator with an
 * error and no connector to look at. Same rule as `ProviderService.create`.
 *
 * **4. Discovery is a snapshot, and registration is additive.**
 * `Connector.capabilityDiscovery` is replaced wholesale on every probe, because it is the vendor's
 * advertisement and evidence should not accumulate. The canonical `Tool` rows are *upserted* — an
 * action that disappears is disabled rather than deleted, so a run that already referenced it can
 * still render its history.
 *
 * ## Where a connector's credential lives
 *
 * `Connector` has no `credentialId` column — only `ConnectorAccount` does. So the connector-level
 * credential's id is kept in `metadata.credentialId`, and resolution is:
 * **the account's own credential, else the connector's.** That is what makes the common case (one
 * token for the whole integration) and the multi-account case (a token per GitHub login) the same
 * code path.
 *
 * An id in plaintext metadata is safe in a way a token is not: it is a handle, it grants nothing on
 * its own, and every read of the credential it names still goes through a tenant-scoped lookup.
 */

export interface ConnectorServiceDeps {
  connectors: ConnectorRepository;
  accounts: ConnectorAccountRepository;
  credentials: CredentialRepository;
  tools: ToolRepository;
  vault: VaultService;
  logger: Logger;
  /** Injected so a test drives a whole connector with no network. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  emit?: EngineEmitter;
}

export class ConnectorService {
  constructor(private readonly deps: ConnectorServiceDeps) {}

  // ── reading ─────────────────────────────────────────────────────────────────

  async list(tenantId: string, query: ListConnectorsQuery): Promise<ConnectorDetail[]> {
    const rows = await this.deps.connectors.list(tenantId, {
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.status === undefined ? {} : { status: query.status }),
    });

    const counts = await this.deps.accounts.countsByConnector(rows.map((row) => row.id));

    // The list is sliced in memory rather than in SQL. A tenant has tens of connectors, not
    // thousands, and pushing the window into the query would mean a second count query to report
    // the total. The same trade `ModelService.list` makes, for the same reason.
    return rows
      .slice(query.offset, query.offset + query.limit)
      .map((row) => this.toDetail(row, counts.get(row.id) ?? 0, [], new Map()));
  }

  /**
   * One connector, composed.
   *
   * Four reads, all keyed off the first: the row, its accounts, its canonical tools, and the
   * capability snapshot that is already on the row. The tools are read to resolve each capability's
   * `toolId` — the join key is the adapter's `action`, stored in `Tool.metadata.externalId`,
   * because the canonical tool *name* is a slugged label that is never parsed back.
   */
  async get(tenantId: string, id: string): Promise<ConnectorDetail> {
    const connector = await this.require(tenantId, id);
    const [accounts, tools] = await Promise.all([
      this.deps.accounts.listForConnector(connector.id),
      this.deps.tools.listForSource(tenantId, sourceOf(connector.id)),
    ]);

    return this.toDetail(connector, accounts.length, accounts, toolIdByAction(tools));
  }

  async listAccounts(
    tenantId: string,
    connectorId: string,
    query: ListConnectorAccountsQuery,
  ): Promise<ConnectorAccountSummary[]> {
    const connector = await this.require(tenantId, connectorId);
    const accounts = await this.deps.accounts.listForConnector(connector.id);
    return accounts.slice(query.offset, query.offset + query.limit).map(toConnectorAccountSummary);
  }

  // ── writing ─────────────────────────────────────────────────────────────────

  /**
   * Create a connector, and probe it.
   *
   * The credential is written **before** the row, so a connector can never exist in a state where
   * it references a credential that was never stored. If the row write then fails, the orphaned
   * credential is inert — it is not referenced by anything and it costs one row.
   *
   * ## Why the probe runs even when no token was supplied
   *
   * The first version of this method skipped the probe when `token` was absent, on the reasoning
   * that probing a half-configured connector would report a failure the operator had not caused.
   * That was wrong, and it produced a connector with no capabilities and no tools — a row that
   * exists, lists, and can do nothing, which is exactly the present-and-broken state rule 2 above
   * exists to prevent.
   *
   * The error was conflating *no credential* with *cannot work*. A `rest` connector often needs no
   * credential at all, so skipping its probe skipped the only thing that registers its actions. A
   * `github` connector without a token genuinely does not work, and saying so immediately — with
   * the vendor's own `Bad credentials` — is more useful than silence.
   *
   * Discovery is the point of creating a connector. If it cannot run, the response says why.
   */
  async create(
    tenantId: string,
    input: CreateConnectorInput,
  ): Promise<{ connector: ConnectorDetail; test: ConnectorTestResult }> {
    if (!hasConnectorAdapter(input.type)) {
      throw new ApiError('UNSUPPORTED_CAPABILITY', `No adapter implements the "${input.type}" connector`, {
        type: input.type,
        implemented: implementedConnectorTypes(),
      });
    }

    const metadata: Record<string, unknown> = {};
    if (input.config !== undefined) metadata.config = input.config;

    if (input.token !== undefined) {
      const credential = await this.storeCredential(tenantId, `${input.name} token`, input.token);
      metadata.credentialId = credential.id;
      metadata.keyPrefix = credential.keyPrefix;
    }

    const created = await this.deps.connectors.create({
      tenantId,
      type: input.type,
      name: input.name,
      status: 'disconnected',
      metadata: metadata as never,
    });

    // Probed unconditionally, and the row is re-read afterwards so the response describes the
    // connector as it is *after* the probe rather than before it.
    const test = await this.test(tenantId, created.id);
    const connector = await this.get(tenantId, created.id);

    return { connector, test };
  }

  /**
   * Edit a connector, or rotate its credential.
   *
   * A supplied `token` is a **rotation**: a new `Credential` row is written and the metadata
   * reference is repointed. The old row is left in place, because it is the record of what was in
   * use and an incident review needs to see it. `config` replaces the stored config wholesale —
   * a partial merge would leave a base URL from the previous configuration behind an action list
   * from the new one.
   */
  async update(tenantId: string, id: string, input: UpdateConnectorInput): Promise<ConnectorDetail> {
    const connector = await this.require(tenantId, id);

    const metadata: Record<string, unknown> = { ...readRawMetadata(connector.metadata) };
    if (input.config !== undefined) metadata.config = input.config;

    if (input.token !== undefined) {
      const credential = await this.storeCredential(tenantId, `${connector.name} token`, input.token);
      metadata.credentialId = credential.id;
      metadata.keyPrefix = credential.keyPrefix;
      // A rotation clears the last failure: it describes the *previous* credential, and leaving it
      // on the page would make a freshly rotated connector look broken.
      delete metadata.lastError;
    }

    await this.deps.connectors.update(tenantId, id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      metadata: metadata as never,
    });

    return this.get(tenantId, id);
  }

  /**
   * Remove a connector.
   *
   * Order matters. The canonical tools are disabled **first**, so that a failure part-way through
   * leaves a connector with no usable tools rather than tools pointing at a connector that is
   * about to disappear. Accounts are deleted explicitly rather than left to the schema's cascade,
   * because their credential rows are *not* cascaded and an explicit delete is the only place that
   * decision is visible.
   *
   * The credentials are deliberately **not** deleted. A credential may be shared — an account can
   * reference the connector's own — and deleting one that another row still names would break that
   * row silently. The vault is small and a rotation is cheap; an orphaned entry is the safer error.
   */
  async remove(tenantId: string, id: string): Promise<void> {
    const connector = await this.require(tenantId, id);

    await this.deps.tools.disableMissingForSource(tenantId, sourceOf(connector.id), []);

    const accounts = await this.deps.accounts.listForConnector(connector.id);
    for (const account of accounts) await this.deps.accounts.delete(account.id);

    await this.deps.connectors.delete(tenantId, id);

    this.deps.logger.info(
      { connectorId: id, type: connector.type, accounts: accounts.length },
      'connector removed',
    );
  }

  /**
   * Attach an account.
   *
   * Without a `token` the account has no credential of its own and inherits the connector's. That
   * is not a degraded state — it is how a single-token integration is expressed — and the account
   * row says so honestly through `hasCredential: false`.
   */
  async addAccount(
    tenantId: string,
    connectorId: string,
    input: CreateConnectorAccountInput,
  ): Promise<ConnectorAccountSummary> {
    const connector = await this.require(tenantId, connectorId);

    const credential =
      input.token === undefined
        ? null
        : await this.storeCredential(
            tenantId,
            `${connector.name} · ${input.label}`,
            input.token,
          );

    const account = await this.deps.accounts.create({
      connectorId: connector.id,
      label: input.label,
      accountId: input.accountId ?? null,
      credentialId: credential?.id ?? null,
      scopes: input.scopes ?? [],
      status: 'active',
    });

    return toConnectorAccountSummary(account);
  }

  /**
   * Remove an account.
   *
   * Refuses to remove the last account when the connector has no credential of its own. Deleting it
   * would leave a connector that is listed as connected and has nothing to authenticate with — a
   * broken state reachable by one click, which is exactly the kind of state an API should make
   * unreachable rather than discoverable.
   */
  async removeAccount(tenantId: string, connectorId: string, accountId: string): Promise<void> {
    const connector = await this.require(tenantId, connectorId);

    const accounts = await this.deps.accounts.listForConnector(connector.id);
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (account === undefined) {
      throw new ApiError('NOT_FOUND', 'No such account on this connector', { accountId });
    }

    const hasConnectorCredential = readCredentialId(connector) !== null;
    if (accounts.length === 1 && !hasConnectorCredential && account.credentialId !== null) {
      throw new ApiError(
        'CONFLICT',
        'This is the connector’s only credential. Add another account first, or delete the connector.',
        { accountId },
      );
    }

    await this.deps.accounts.delete(account.id);
  }

  // ── probing and discovery ───────────────────────────────────────────────────

  /**
   * Prove the connector works, and register what it can do.
   *
   * The probe uses the first account when there is one and the connector's own credential
   * otherwise. Accounts are tried in creation order, which is stable and therefore reproducible:
   * a probe that picked a different account each time would make `test` a different question on
   * every call.
   *
   * A failure is reported, not thrown. `POST /:id/test` is a request that was performed and whose
   * answer is "this does not work" — the operator needs the vendor's reason, and a 502 describing
   * the diagnosis would be strictly less useful than a 200 carrying it.
   */
  async test(tenantId: string, id: string): Promise<ConnectorTestResult> {
    const connector = await this.require(tenantId, id);

    try {
      const accounts = await this.deps.accounts.listForConnector(connector.id);
      const account = accounts[0] ?? null;
      const adapter = createConnectorAdapter(connector.type);
      const ctx = await this.buildContext(tenantId, connector, account, adapter);

      const identity = await adapter.connect(ctx, toAccountRef(account));

      // The vendor is the authority on which remote account this is and what it may do. The
      // operator's `label` is never overwritten — it is their name for the account, not the
      // vendor's.
      if (account !== null && identity !== null) {
        await this.deps.accounts.update(account.id, {
          ...(identity.accountId === null ? {} : { accountId: identity.accountId }),
          ...(identity.scopes.length === 0 ? {} : { scopes: identity.scopes }),
        });
      }

      const discovered = await adapter.discoverCapabilities(ctx);
      const registered = await this.registerCapabilities(tenantId, connector, discovered, account);

      await this.deps.connectors.setDiscovery(tenantId, id, discovered as never);
      await this.deps.connectors.setStatus(tenantId, id, 'connected');
      await this.clearError(tenantId, connector);

      this.deps.emit?.(tenantId, {
        name: 'connector.connected',
        payload: { connectorId: id },
      });

      this.deps.logger.info(
        { connectorId: id, type: connector.type, discovered: discovered.length, registered },
        'connector probed',
      );

      return toConnectorTestResult(id, {
        ok: true,
        status: 'connected',
        discovered: discovered.length,
        registered,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.deps.connectors.setStatus(tenantId, id, 'error');
      await this.setError(tenantId, connector, message);

      this.deps.logger.warn({ connectorId: id, err: message }, 'connector probe failed');

      return toConnectorTestResult(id, {
        ok: false,
        status: 'error',
        discovered: 0,
        registered: 0,
        error: message,
      });
    }
  }

  // ── the invoker's entry point ───────────────────────────────────────────────

  /**
   * Run one connector action on behalf of the engine.
   *
   * Called by `ToolInvoker` for any tool of type `connector`. Everything it needs is on the `Tool`
   * row — `provider` names the connector, `metadata.externalId` names the adapter's action, and
   * `connectorAccountId` names the account — so the invoker never has to know what a connector is.
   *
   * This deliberately does **not** re-check `Tool.status`. The invoker resolves and checks the tool
   * before dispatching, and a second check here would be a second opinion about a fact that has
   * already been decided — the kind of duplicate that eventually disagrees with the first.
   */
  async executeAction(
    tenantId: string,
    tool: Tool,
    args: Record<string, unknown>,
  ): Promise<ConnectorActionResult> {
    const connectorId = tool.provider;
    if (connectorId === null || connectorId === '') {
      throw new ApiError('INTERNAL_ERROR', `Connector tool "${tool.name}" names no connector`, {
        toolId: tool.id,
      });
    }

    const action = readExternalId(tool);
    if (action === null) {
      // Without this the adapter would be asked to run an action whose name we do not know, and its
      // "no such action" error would be about a string that was never a candidate.
      throw new ApiError('INTERNAL_ERROR', `Connector tool "${tool.name}" has no recorded action`, {
        toolId: tool.id,
      });
    }

    const connector = await this.require(tenantId, connectorId);
    const adapter = createConnectorAdapter(connector.type);

    const account =
      tool.connectorAccountId === null
        ? (await this.deps.accounts.listForConnector(connector.id))[0] ?? null
        : await this.requireAccount(connector, tool.connectorAccountId);

    const ctx = await this.buildContext(tenantId, connector, account, adapter);

    return adapter.execute(action, args, ctx, toAccountRef(account));
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async require(tenantId: string, id: string): Promise<Connector> {
    const connector = await this.deps.connectors.findById(tenantId, id);
    if (connector === null) throw new ApiError('NOT_FOUND', 'Connector not found', { id });
    return connector;
  }

  /** An account id is only trusted after it is found in this connector's own account list. */
  private async requireAccount(connector: Connector, accountId: string): Promise<ConnectorAccount> {
    const accounts = await this.deps.accounts.listForConnector(connector.id);
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (account === undefined) {
      throw new ApiError('NOT_FOUND', 'The account this tool is bound to no longer exists', {
        accountId,
        connectorId: connector.id,
      });
    }
    return account;
  }

  private async storeCredential(tenantId: string, label: string, token: string) {
    return this.deps.credentials.create({
      tenantId,
      label,
      kind: 'token',
      encrypted: this.deps.vault.encrypt(token),
      // Masked, and only ever used for display. Never derived from for anything security-relevant.
      keyPrefix: maskToken(token),
    });
  }

  /**
   * Assemble everything an adapter needs, decrypting the credential last.
   *
   * The credential is resolved here and nowhere else, which is what makes "where could this token
   * have come from" a single question with a single answer.
   */
  private async buildContext(
    tenantId: string,
    connector: Connector,
    account: ConnectorAccount | null,
    adapter: ConnectorAdapter,
  ): Promise<ConnectorContext> {
    const config = readConnectorConfig(connector.metadata);

    const baseUrl = config.baseUrl ?? adapter.defaultBaseUrl;
    if (baseUrl === null || baseUrl === undefined || baseUrl === '') {
      throw new ApiError('VALIDATION_ERROR', `A ${connector.type} connector needs a base URL`, {
        connectorId: connector.id,
        type: connector.type,
      });
    }

    const credentialId = account?.credentialId ?? readCredentialId(connector);
    let token = '';
    if (credentialId !== null) {
      const credential = await this.deps.credentials.findById(tenantId, credentialId);
      if (credential === null) {
        throw new ApiError(
          'NOT_FOUND',
          'The credential this connector references no longer exists',
          { connectorId: connector.id },
        );
      }
      token = this.deps.vault.decrypt(credential.encrypted);
    }

    return {
      connectorId: connector.id,
      connectorType: connector.type,
      connectorName: connector.name,
      baseUrl,
      config,
      credentials: {
        token,
        authHeader: (config.authHeader ?? 'authorization').toLowerCase(),
        authScheme: config.authScheme ?? 'Bearer',
      },
      fetch: this.deps.fetch ?? globalThis.fetch,
      logger: this.deps.logger,
    };
  }

  /**
   * Turn discovered capabilities into canonical `Tool` rows.
   *
   * This is the step that makes a connector usable: an agent is granted a `Tool.id`, never a
   * connector id, so nothing downstream of this method needs to know connectors exist.
   *
   * `source` is `connector:<id>`, which is the same convention `mcp:<serverId>` follows and what
   * `disableMissingForSource` keys on. The action name goes into `metadata.externalId` because the
   * canonical name is a length-capped slug for a model's benefit and is never parsed back.
   *
   * Returns the number of rows created or refreshed — which can legitimately differ from the number
   * of capabilities, because two actions can collide on the same canonical name after slugging and
   * then share one row.
   *
   * **Public rather than private.** The projection of a capability into a tool row is the connector
   * lifecycle's own step, not an implementation detail of `test`: it is what a capability refresh
   * endpoint would call, and it is what the seed calls so that a seeded connector's tools are
   * registered by *this* code rather than by a second copy of the naming rule and the capability
   * asymmetry check. `applyCapabilityAsymmetry` refuses a newly claimed `read_only`, and a
   * duplicated version of that rule in a script would be a second, weaker opinion about what
   * removes an approval gate.
   *
   * The caller supplies what it already has — the connector row, the capabilities it discovered,
   * and the account they belong to. Passing them in rather than re-reading them keeps the method a
   * pure projection, so it cannot observe a different connector than the one it was handed.
   */
  async registerCapabilities(
    tenantId: string,
    connector: Connector,
    discovered: DiscoveredCapability[],
    account: ConnectorAccount | null,
  ): Promise<number> {
    const source = sourceOf(connector.id);
    const kept: string[] = [];

    for (const capability of discovered) {
      const tool = await this.deps.tools.upsert({
        tenantId,
        source,
        name: canonicalToolName(connector.name, capability.action),
        description:
          capability.description ?? `${capability.name} (${connector.type} connector)`,
        type: 'connector',
        provider: connector.id,
        inputSchema: (capability.inputSchema ?? {}) as never,
        capabilities: capability.capabilities,
        connectorAccountId: account?.id ?? null,
        metadata: {
          externalId: capability.action,
          connectorId: connector.id,
          connectorType: connector.type,
        } as never,
      });

      await this.applyCapabilityAsymmetry(tenantId, tool, capability.capabilities);
      kept.push(tool.id);
    }

    // Actions the connector no longer advertises are disabled, never deleted.
    await this.deps.tools.disableMissingForSource(tenantId, source, kept);

    return kept.length;
  }

  /**
   * The asymmetric capability rule, identical to the MCP manager's.
   *
   * `upsert` never touches `capabilities` after creation, so this is the only post-creation writer.
   * A connector claiming an action has become harmless — newly declaring `read_only` — is refused,
   * because that is exactly what removes an approval gate. Every other change is applied.
   *
   * It matters for a `rest` connector even though the adapter is our own code: the capability set
   * there comes from *tenant configuration*, and a config edited to call a `POST` read-only would
   * otherwise silently take it out of the approval policy.
   */
  private async applyCapabilityAsymmetry(
    tenantId: string,
    tool: Tool,
    next: readonly string[],
  ): Promise<void> {
    const previous = tool.capabilities;
    if (sameSet(previous, next)) return;

    const claimsHarmless = next.includes('read_only') && !previous.includes('read_only');

    if (claimsHarmless) {
      this.deps.logger.warn(
        { toolId: tool.id, toolName: tool.name, previous, declared: next, sideEffects: hasSideEffects(next) },
        'connector declared an action harmless; keeping the recorded capabilities',
      );
      return;
    }

    await this.deps.tools.setCapabilities(tenantId, tool.id, [...next]);
  }

  private async setError(tenantId: string, connector: Connector, message: string): Promise<void> {
    const metadata = { ...readRawMetadata(connector.metadata), lastError: message };
    await this.deps.connectors.update(tenantId, connector.id, { metadata: metadata as never });
  }

  private async clearError(tenantId: string, connector: Connector): Promise<void> {
    const metadata = { ...readRawMetadata(connector.metadata) };
    if (!('lastError' in metadata)) return;
    delete metadata.lastError;
    await this.deps.connectors.update(tenantId, connector.id, { metadata: metadata as never });
  }

  private toDetail(
    connector: Connector,
    accountCount: number,
    accounts: ConnectorAccount[],
    toolIdByAction: ReadonlyMap<string, string>,
  ): ConnectorDetail {
    return toConnectorDetail(connector, { accountCount }, accounts, toolIdByAction);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** The connector-level `Tool.source` convention. One place, so it cannot drift from its readers. */
export function sourceOf(connectorId: string): string {
  return `connector:${connectorId}`;
}

/** The action an adapter dispatches on, as recorded when the tool was registered. */
export function readExternalId(tool: Tool): string | null {
  const metadata = tool.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).externalId;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The connector-level credential's id, out of `metadata`. */
function readCredentialId(connector: Connector): string | null {
  const value = readRawMetadata(connector.metadata).credentialId;
  return typeof value === 'string' && value !== '' ? value : null;
}

function readRawMetadata(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, unknown>) };
}

/**
 * Map each registered action to its canonical tool id.
 *
 * Keyed on `metadata.externalId` — the adapter's action name — and not on `Tool.name`, which is a
 * slugged label that is explicitly never parsed back. A tool with no recorded action is skipped
 * rather than guessed at.
 */
export function toolIdByAction(tools: readonly Tool[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools) {
    const action = readExternalId(tool);
    if (action !== null) map.set(action, tool.id);
  }
  return map;
}

function toAccountRef(account: ConnectorAccount | null): ConnectorAccountRef | null {
  if (account === null) return null;
  return {
    id: account.id,
    accountId: account.accountId,
    label: account.label,
    scopes: [...account.scopes],
  };
}

/**
 * Masked form of a token, for display only.
 *
 * Short tokens are masked entirely. The length threshold is higher than the provider mask's because
 * a connector token is often a long opaque string where a prefix is a real hint, and a short one
 * where it is most of the secret.
 */
export function maskToken(token: string): string {
  if (token.length < 16) return '…';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
