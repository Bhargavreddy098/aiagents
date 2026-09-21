import { ApiError } from '@nexs/shared';
import type {
  ConnectorAdapter,
  ConnectorContext,
  ConnectorIdentity,
  ConnectorActionResult,
  ConnectorAccountRef,
  DiscoveredCapability,
} from '../types.js';
import { carriesBody, credentialHeader, extractMessage, fillPath, joinUrl, parseBody, queryString, sendJson } from '../http.js';

/**
 * GitHub, as a connector.
 *
 * This adapter exists because the spec's Phase 4 acceptance criterion names it: *"GitHub connector
 * with token → capability discovery lists actions."* It is also the second implementation of the
 * interface, which is what makes `rest` a framework rather than a special case.
 *
 * ## Why the action list is declared in code
 *
 * GitHub publishes no machine-readable catalogue of the operations a token may perform. There is no
 * `/actions` endpoint to call, so "discovery" for GitHub cannot mean fetching a list — it can only
 * mean stating the adapter's own contract. This list *is* that contract, and the honest reading of
 * `discoverCapabilities` here is "here is what this adapter knows how to do", not "here is what
 * GitHub says you may do".
 *
 * What genuinely varies per tenant is *authorisation*: the token's scopes decide which of these
 * actions will actually succeed, and `connect` reads the scopes GitHub reports and returns them, so
 * the account row records them. A `create_issue` on a read-only token is therefore visible as a
 * scope mismatch rather than discovered by failing a write.
 *
 * ## The declared schemas are part of the contract too
 *
 * Every action carries a real JSON Schema. `rest` can fall back to deriving arguments from its path
 * placeholders because a placeholder is provably required; GitHub's body fields have no such
 * signal, and a model given `additionalProperties: true` for `create_issue` would invent field
 * names. So the schemas are written out.
 */

const API_VERSION = '2022-11-28';

export class GitHubConnectorAdapter implements ConnectorAdapter {
  readonly type = 'github';

  /** Overridable through `config.baseUrl` for GitHub Enterprise. */
  readonly defaultBaseUrl = 'https://api.github.com';

  /**
   * Prove the token works and learn which account it belongs to.
   *
   * `GET /user` is the one endpoint that is both universally available and identity-bearing, so it
   * is the probe. Unlike the `rest` adapter this one *does* establish credential validity, because
   * GitHub will answer a bad token with a 401 — which is exactly the difference between a vendor
   * with an identity endpoint and one without.
   *
   * The scopes come from the `x-oauth-scopes` response header, which is the only place GitHub
   * reports them. That is why this method reads the response directly instead of going through
   * `sendJson`, which discards headers.
   */
  async connect(ctx: ConnectorContext): Promise<ConnectorIdentity | null> {
    const response = await this.fetchUser(ctx);
    const text = await response.text().catch(() => '');
    const payload = parseBody(text);

    if (!response.ok) {
      throw new ApiError(
        'PROVIDER_ERROR',
        `GitHub rejected the credential (${response.status}): ${extractMessage(payload, response.statusText)}`,
        { connectorId: ctx.connectorId, status: response.status },
      );
    }

    if (payload === null || typeof payload !== 'object') {
      throw new ApiError('PROVIDER_ERROR', 'GitHub returned an unrecognised user payload', {
        connectorId: ctx.connectorId,
      });
    }

    const user = payload as Record<string, unknown>;
    const login = typeof user.login === 'string' ? user.login : null;
    const displayName = typeof user.name === 'string' && user.name !== '' ? user.name : null;

    return {
      accountId: login,
      // The login is the stable identifier and the display name is the readable one. Falling back
      // to the login keeps the label useful for an account whose owner never set a name.
      label: displayName ?? login,
      scopes: parseScopes(response.headers.get('x-oauth-scopes')),
    };
  }

  /** Stateless HTTP; there is nothing held open. See the interface for why this is still here. */
  async disconnect(): Promise<void> {
    // Intentionally empty.
  }

  async discoverCapabilities(_ctx: ConnectorContext): Promise<DiscoveredCapability[]> {
    // A copy, so a caller that mutates the result cannot corrupt the adapter's contract for the
    // next tenant in the same process.
    return GITHUB_ACTIONS.map((action) => ({ ...action, capabilities: [...action.capabilities] }));
  }

  async execute(
    action: string,
    args: Record<string, unknown>,
    ctx: ConnectorContext,
    _account: ConnectorAccountRef | null,
  ): Promise<ConnectorActionResult> {
    const declared = GITHUB_ACTIONS.find((candidate) => candidate.action === action);

    if (declared === undefined) {
      throw new ApiError('NOT_FOUND', `GitHub connector has no action "${action}"`, {
        action,
        available: GITHUB_ACTIONS.map((candidate) => candidate.action),
      });
    }

    const { path, rest } = fillPath(PATH_BY_ACTION[action]!, args);
    const body = carriesBody(declared.method);
    const url = `${joinUrl(ctx.baseUrl, path)}${queryString(body ? {} : rest)}`;

    return sendJson(ctx, url, {
      method: declared.method,
      headers: { 'x-github-api-version': API_VERSION },
      ...(body ? { body: rest } : {}),
    });
  }

  /** The one call that needs response headers, so it does not share `sendJson`. */
  private async fetchUser(ctx: ConnectorContext): Promise<Response> {
    try {
      return await ctx.fetch(joinUrl(ctx.baseUrl, '/user'), {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': API_VERSION,
          ...(credentialHeader(ctx) ?? {}),
        },
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    } catch (cause) {
      throw new ApiError('PROVIDER_ERROR', `Could not reach GitHub: ${String(cause)}`, {
        connectorId: ctx.connectorId,
      });
    }
  }
}

/**
 * GitHub's scope header, which is a comma-separated list and is absent when the token is a
 * fine-grained one. Absent is not "no scopes" — fine-grained tokens do not report scopes at all —
 * so it returns an empty list and the account row records nothing rather than something false.
 */
export function parseScopes(header: string | null): string[] {
  if (header === null || header.trim() === '') return [];
  return header
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '');
}

interface GitHubAction {
  action: string;
  name: string;
  description: string;
  method: string;
  capabilities: string[];
  inputSchema: Record<string, unknown>;
}

const ownerRepo = {
  owner: { type: 'string', description: 'Repository owner (user or organisation)' },
  repo: { type: 'string', description: 'Repository name' },
} as const;

/**
 * What this adapter can do.
 *
 * Kept as data rather than as eight methods so that `discoverCapabilities` and `execute` cannot
 * disagree about what exists — the dispatch table is derived from this list, and a test asserts
 * every declared action has a path.
 */
const GITHUB_ACTIONS: readonly GitHubAction[] = [
  {
    action: 'get_authenticated_user',
    name: 'Get authenticated user',
    description: 'The account the credential belongs to.',
    method: 'GET',
    capabilities: ['read_only'],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    action: 'get_repo',
    name: 'Get repository',
    description: 'Metadata for one repository.',
    method: 'GET',
    capabilities: ['read_only'],
    inputSchema: {
      type: 'object',
      properties: { ...ownerRepo },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    action: 'list_issues',
    name: 'List issues',
    description: 'Issues in a repository, most recently updated first.',
    method: 'GET',
    capabilities: ['read_only'],
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepo,
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        labels: { type: 'string', description: 'Comma-separated label names' },
        per_page: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    action: 'create_issue',
    name: 'Create issue',
    description: 'Open a new issue. This writes to the repository.',
    method: 'POST',
    capabilities: ['external_side_effect', 'notify'],
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepo,
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        assignees: { type: 'array', items: { type: 'string' } },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    action: 'add_issue_comment',
    name: 'Add issue comment',
    description: 'Comment on an issue or pull request. This writes to the repository.',
    method: 'POST',
    capabilities: ['external_side_effect', 'notify'],
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepo,
        issue_number: { type: 'integer', minimum: 1 },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
      additionalProperties: false,
    },
  },
  {
    action: 'list_pull_requests',
    name: 'List pull requests',
    description: 'Pull requests in a repository.',
    method: 'GET',
    capabilities: ['read_only'],
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepo,
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        per_page: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    action: 'get_file_contents',
    name: 'Get file contents',
    description: 'One file or directory listing at a ref.',
    method: 'GET',
    capabilities: ['read_only'],
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepo,
        path: { type: 'string' },
        ref: { type: 'string', description: 'Branch, tag or commit SHA' },
      },
      required: ['owner', 'repo', 'path'],
      additionalProperties: false,
    },
  },
  {
    action: 'search_issues',
    name: 'Search issues and pull requests',
    description: 'GitHub search across issues and pull requests.',
    method: 'GET',
    capabilities: ['read_only', 'search'],
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'GitHub search query, e.g. "repo:owner/name is:open"' },
        per_page: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['q'],
      additionalProperties: false,
    },
  },
];

/**
 * Where each action sends its request.
 *
 * Separate from `GITHUB_ACTIONS` so the path templates can carry `{placeholders}` that the declared
 * JSON Schemas describe in prose. A test asserts the two agree, which is what stops an action being
 * added with a schema and no route.
 */
const PATH_BY_ACTION: Record<string, string> = {
  get_authenticated_user: '/user',
  get_repo: '/repos/{owner}/{repo}',
  list_issues: '/repos/{owner}/{repo}/issues',
  create_issue: '/repos/{owner}/{repo}/issues',
  add_issue_comment: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
  list_pull_requests: '/repos/{owner}/{repo}/pulls',
  get_file_contents: '/repos/{owner}/{repo}/contents/{path}',
  search_issues: '/search/issues',
};

export const GITHUB_ACTION_PATHS = PATH_BY_ACTION;
export const GITHUB_DECLARED_ACTIONS = GITHUB_ACTIONS;
