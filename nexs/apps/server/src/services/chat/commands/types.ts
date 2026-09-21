import {
  ALWAYS_ALLOWED_COMMANDS,
  ALL_COMMAND_SURFACES,
  type AgentDetail,
  type AgentSummary,
  type CommandSurface,
  type GoalDetail,
  type RunDetail,
  type RunSummary,
} from '@nexs/shared';

/**
 * Slash commands (§3.8).
 *
 * ## What a command is, and what it is not
 *
 * A command is a **handler with a service behind it**. The spec is explicit: "Every command is
 * backed by a real service — no canned text for listings." So `/agents` reads the agent
 * repository and prints what is actually there; it does not print a paragraph explaining what
 * agents are. That rule is the difference between a command palette and a help page, and it is
 * the reason `run()` is `async` and returns a `reply` built from real rows.
 *
 * ## Why the reply is a string
 *
 * A command's output is *chat text*, rendered in the transcript beside the model's answers.
 * Returning structured data would push rendering into the client and mean two implementations
 * of "how do I show a run list" — one for chat, one for the Runs page. A string here is the
 * honest representation of "this is what the assistant would have said".
 *
 * ## Why no command throws for a user error
 *
 * A bad argument is a normal thing to type. `/approve` with no id, `/run` with no task — these
 * produce a reply explaining the usage, not a 500. Only a genuine service failure propagates,
 * and the registry turns that into a reply too, so a broken command cannot break the turn.
 */
export interface SlashCommand {
  name: string;
  /** Shown in `/help`. The `<>` convention: required, `[]`: optional. */
  usage: string;
  description: string;
  /**
   * Which client classes may run this — §9's "surface availability" column.
   *
   * Required, not optional, and that is the point: §9 says the composer menu, CLI/TUI
   * autocomplete and every channel's platform menu all render from **one** registry, so a
   * command that forgot to declare where it runs would render in a menu that cannot run it.
   * Forcing the declaration makes the omission a compile error instead of a dead menu entry.
   */
  surfaces: readonly CommandSurface[];
  /**
   * Owner-only (`operator.admin`), per §5.2/§5.6.
   *
   * The privileged commands — the ones that change the gateway's own configuration rather
   * than the workspace's contents. A regular user on a restricted channel account does not see
   * these at all, which is why the flag lives on the command rather than being re-derived at
   * each rendering site.
   */
  adminOnly: boolean;
  run(args: ParsedArgs, ctx: ChatContext): Promise<{ reply: string }>;
}

/**
 * A command as a module declares it: identity, output and handler.
 *
 * `surfaces` and `adminOnly` are omitted so they are defaulted **once**, in
 * `createSlashCommands`, rather than restated in all four command modules. A module that
 * genuinely differs (an owner-only or channel-only command) sets them explicitly; everything
 * else inherits "every surface, not admin-only", which is the truth for the listing and
 * creation commands.
 */
export type CommandDraft = Omit<SlashCommand, 'surfaces' | 'adminOnly'> &
  Partial<Pick<SlashCommand, 'surfaces' | 'adminOnly'>>;

/**
 * The per-account command policy a channel applies (§5.2: `allow_admin_from`,
 * `user_allowed_commands`).
 *
 * Both fields are optional and `undefined` means **unrestricted**, which is the honest
 * default for a tenant that has not configured the split. An empty array is *not* the same
 * thing: it means "narrowed to the floor", and only `ALWAYS_ALLOWED_COMMANDS` survive it.
 */
export interface CommandRegistryPolicy {
  /** Is this caller the command owner? Only then may an `adminOnly` command run. */
  isAdmin: boolean;
  /** `undefined` = unrestricted. An array is a floor; `/help` and `/whoami` are always in it. */
  userAllowedCommands?: readonly string[];
}

/**
 * The commands a caller may actually see, filtered by the account's policy.
 *
 * §9 requires the filter at *render* time as well as at dispatch: a menu that offers `/stop`
 * and then answers "not allowed" is worse than a menu that does not offer it. The floor is
 * applied here so no caller has to remember it.
 */
export function visibleCommands<T extends { name: string; adminOnly: boolean }>(
  commands: readonly T[],
  policy: CommandRegistryPolicy,
): T[] {
  if (policy.isAdmin && policy.userAllowedCommands === undefined) return [...commands];
  if (policy.isAdmin) return [...commands];

  const allowed = policy.userAllowedCommands;
  return commands.filter((command) => {
    if (command.adminOnly) return false;
    if (allowed === undefined) return true;
    // The floor: `/help` is how a restricted user discovers what they may run.
    if ((ALWAYS_ALLOWED_COMMANDS as readonly string[]).includes(command.name)) return true;
    return allowed.includes(command.name);
  });
}

/**
 * Everything a client needs to render a command picker, and what `/help` prints.
 *
 * `surfaces` and `adminOnly` are part of the projection rather than dropped, because the
 * palette draws a glyph per available surface and an "admin" badge — both driven by these
 * fields. Dropping them would force the client to fetch the registry from somewhere else.
 */
export interface CommandDescriptor {
  name: string;
  usage: string;
  description: string;
  surfaces: readonly CommandSurface[];
  adminOnly: boolean;
}

/** Project a command set down to the descriptors a picker renders. */
export function describeCommands(
  commands: readonly SlashCommand[] | Map<string, SlashCommand>,
): CommandDescriptor[] {
  const list = commands instanceof Map ? [...commands.values()] : [...commands];
  return list
    .map(({ name, usage, description, surfaces, adminOnly }) => ({
      name,
      usage,
      description,
      surfaces,
      adminOnly,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The default a `CommandDraft` gets when it does not say: everywhere, and not admin-only. */
export const DEFAULT_COMMAND_SURFACES: readonly CommandSurface[] = ALL_COMMAND_SURFACES;

/**
 * The caller's identity and the services a command may reach.
 *
 * `tenantId` is not optional and is not read from the request inside a command: a command is
 * handed the scope it may act in, so there is no path by which one could accidentally query
 * without a tenant.
 */
export interface ChatContext {
  tenantId: string;
  userId: string;
  sessionId: string;
  /**
   * The command policy in force for this caller (§5.2).
   *
   * Carried on the context rather than passed alongside it because every rendering site — the
   * `/help` reply, the palette, a channel menu — needs the same answer to "what may this person
   * run?", and threading it separately would give three places to get it wrong. Absent means
   * "unrestricted, not an owner", which is the correct reading of a caller that never declared
   * a policy: the Control UI does not apply the channel split.
   */
  policy?: CommandRegistryPolicy;
  /** The services a command can reach. Every one is a real, already-wired service. */
  services: CommandServices;
}

/**
 * The services commands are allowed to use.
 *
 * Declared structurally rather than importing nine service classes, for the same reason the
 * container's ports are: a command should depend on the three methods it calls, not on the
 * forty a service has. It also means a test can hand a command a two-line fake.
 */
export interface CommandServices {
  agents: {
    list(tenantId: string): Promise<AgentSummary[]>;
    create(tenantId: string, input: { name: string; description?: string }): Promise<AgentDetail>;
    get(tenantId: string, id: string): Promise<AgentDetail>;
  };
  goals: {
    list(tenantId: string): Promise<{ id: string; title: string; status: string }[]>;
    create(tenantId: string, input: { title: string; description?: string }): Promise<GoalDetail>;
  };
  tasks: {
    create(
      tenantId: string,
      input: {
        title: string;
        triggerType: 'manual';
        agentId?: string;
        description?: string;
      },
    ): Promise<{ id: string; title: string }>;
  };
  runs: {
    list(
      tenantId: string,
      query: { status?: string; limit?: number },
    ): Promise<{ runs: RunSummary[]; total: number }>;
    get(tenantId: string, id: string): Promise<RunDetail>;
    cancel(tenantId: string, id: string): Promise<RunDetail>;
    pause(tenantId: string, id: string): Promise<RunDetail>;
    resume(tenantId: string, id: string): Promise<RunDetail>;
  };
  approvals: {
    list(
      tenantId: string,
      filters: { status?: 'pending' | 'approved' | 'rejected' | 'expired'; limit?: number },
    ): Promise<{ id: string; runId: string | null; status: string; title: string }[]>;
    /**
     * `userId` is third because the decision is attributed to a person — the inbox records who
     * allowed what, and a chat command must not be a way to approve anonymously.
     */
    decide(
      tenantId: string,
      id: string,
      userId: string,
      input: { decision: 'approved' | 'rejected'; reason?: string },
    ): Promise<{
      approval: { id: string; status: string };
      runOutcome: { status: string; runId: string } | null;
    }>;
    countPending(tenantId: string): Promise<number>;
  };
  notifications: {
    /** Unread count, which `/status` reports as part of the system state. */
    unreadCount(tenantId: string, userId: string): Promise<number>;
  };
  models: {
    list(tenantId: string): Promise<{ id: string; name: string; providerName: string }[]>;
  };
  tools: {
    list(tenantId: string): Promise<{ id: string; name: string; status: string }[]>;
  };
  mcp: {
    list(tenantId: string): Promise<{ id: string; name: string; status: string }[]>;
  };
  /** Provider health, for `/status`. */
  providers: {
    list(tenantId: string): Promise<{ id: string; name: string; status: string }[]>;
  };
  /**
   * Read-only browser access for `/browser`.
   *
   * Three calls rather than one, because that is the real API: `open` creates an isolated
   * `BrowserContext`, `act` does one thing in it, `close` tears it down. The command opens,
   * reads, and closes — it deliberately leaves no session behind, since a slash command is not
   * a browser tab and a leaked Chromium context is a real cost.
   *
   * The action set is limited to the three the spec names. `navigate` is included because it
   * is how a URL is reached; `screenshot`, `inspect` (title) and `extract` (text) are the
   * reads. Everything with a side effect — click, type, upload — is excluded on purpose: those
   * belong in the approval flow, not in a text box.
   */
  browser: {
    open(tenantId: string, options: { url?: string }): Promise<{ id: string }>;
    act(
      tenantId: string,
      sessionId: string,
      action: { type: 'navigate'; url: string } | { type: 'screenshot' } | { type: 'inspect' } | { type: 'extract'; selector: string },
    ): Promise<{ currentUrl: string | null; title: string | null; output?: unknown }>;
    close(tenantId: string, sessionId: string): Promise<void>;
  };
}

/**
 * Parsed arguments.
 *
 * Both a positional list and a flag map, because §3.8's syntax needs both: `/agent <name>
 * <instructions>` is positional while `/run <task> --agent <id>` carries a flag. Parsing once,
 * here, means no command re-implements `--` handling and gets it subtly different.
 */
export interface ParsedArgs {
  /** Whitespace-separated tokens that are not flags. */
  positional: string[];
  /** `--flag value` pairs. A flag with no value maps to `''`. */
  flags: Record<string, string>;
  /** The raw text after the command name, for commands that want the whole thing. */
  raw: string;
}

/**
 * Split a command line into positional arguments and flags.
 *
 * ## Quoting
 *
 * Double quotes group tokens, because `/agent Scout "watch Hacker News hourly"` is the only way
 * to pass multi-word instructions, and without it the *first* word of the user's instruction
 * would silently become the agent's description. Unterminated quotes are tolerated rather than
 * rejected: this runs on text someone is typing, and refusing to parse a half-typed quote would
 * make the composer unusable mid-word.
 *
 * ## Flags
 *
 * A flag consumes the next token as its value unless that token is itself a flag, so
 * `/runs --status` leaves `status` empty rather than swallowing the next word. That is the
 * behaviour a user gets from every shell, and matching it means no surprises.
 */
export function parseArgs(raw: string): ParsedArgs {
  const tokens = tokenize(raw);
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';

    if (!token.startsWith('--') || token === '--') {
      positional.push(token);
      continue;
    }

    const name = token.slice(2);
    if (name.length === 0) {
      positional.push(token);
      continue;
    }

    const next = tokens[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = '';
      continue;
    }

    flags[name] = next;
    i += 1;
  }

  return { positional, flags, raw };
}

/** Split on whitespace, honouring double quotes. */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of raw) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}
