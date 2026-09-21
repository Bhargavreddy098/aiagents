import type { ChatContext, CommandDraft, ParsedArgs } from './types.js';

/**
 * The listing commands: `/status`, `/models`, `/agents`, `/goals`, `/runs`, `/tools`, `/mcp`,
 * `/skills`.
 *
 * These are the commands the spec singles out with a rule — "no canned text for listings" — so
 * each one reads its service and renders what is there. An empty registry produces "no agents
 * yet", not a description of what an agent is, and that distinction is the whole point: a user
 * who runs `/agents` is asking a question about *their* workspace.
 *
 * `/help` is not here: it lists the command table, so it can only be built where the table is —
 * see `createSlashCommands`.
 */

/** How many rows a listing shows before it says "and N more". */
const LIST_LIMIT = 25;

export function createRegistryCommands(ctx: ChatContext): CommandDraft[] {
  const { services } = ctx;

  return [
    {
      name: 'status',
      usage: '/status',
      description: 'Provider health, running runs, and pending approvals',
      async run(): Promise<{ reply: string }> {
        // Three reads in parallel: they are independent, and a status command that took three
        // round-trips would be slow enough to feel broken.
        const [providers, runs, pending] = await Promise.all([
          services.providers.list(ctx.tenantId),
          services.runs.list(ctx.tenantId, { limit: 200 }),
          services.approvals.countPending(ctx.tenantId),
        ]);

        const active = runs.runs.filter((run) =>
          ['queued', 'planning', 'running', 'waiting_approval', 'paused'].includes(run.status),
        );

        const unhealthy = providers.filter((p) => p.status !== 'healthy');

        const lines = [
          `**System status**`,
          ``,
          `Providers — ${providers.length} configured` +
            (unhealthy.length === 0
              ? ', all healthy'
              : `, ${unhealthy.length} needing attention:`),
          ...unhealthy.map((p) => `  • ${p.name} — ${p.status}`),
          ``,
          `Active runs — ${active.length} of ${runs.total}`,
          ...active.slice(0, 10).map((run) => `  • ${run.id.slice(0, 8)} · ${run.status}`),
          ...(active.length > 10 ? [`  … and ${active.length - 10} more`] : []),
          ``,
          `Pending approvals — ${pending}`,
        ];

        return { reply: lines.join('\n') };
      },
    },

    {
      name: 'models',
      usage: '/models',
      description: 'List the models in your catalog',
      async run(): Promise<{ reply: string }> {
        const models = await services.models.list(ctx.tenantId);
        if (models.length === 0) {
          return { reply: 'No models configured yet. Add a provider key, then sync its models.' };
        }
        return { reply: render(models, (m) => `\`${m.id}\` — ${m.name} (${m.providerName})`) };
      },
    },

    {
      name: 'agents',
      usage: '/agents',
      description: 'List your agents',
      async run(): Promise<{ reply: string }> {
        const agents = await services.agents.list(ctx.tenantId);
        if (agents.length === 0) {
          return {
            reply: 'No agents yet. Create one with `/agent <name> <instructions>`.',
          };
        }
        return {
          reply: render(agents, (a) => `\`${a.id}\` — **${a.name}** · ${a.status}`),
        };
      },
    },

    {
      name: 'goals',
      usage: '/goals',
      description: 'List your goals',
      async run(): Promise<{ reply: string }> {
        const goals = await services.goals.list(ctx.tenantId);
        if (goals.length === 0) {
          return { reply: 'No goals yet. Create one with `/goal <title> [description]`.' };
        }
        return { reply: render(goals, (g) => `\`${g.id}\` — ${g.title} · ${g.status}`) };
      },
    },

    {
      name: 'runs',
      usage: '/runs [status]',
      description: 'List recent runs, optionally filtered by status',
      async run(args: ParsedArgs): Promise<{ reply: string }> {
        // The status comes from the flag or the bare positional, so both `/runs failed` and
        // `/runs --status failed` work — the spec writes it as an optional positional, but a
        // user who has used the CLI will reach for `--status`.
        const status = args.flags.status ?? args.positional[0];

        const result = await services.runs.list(ctx.tenantId, {
          ...(status === undefined || status.length === 0 ? {} : { status }),
          limit: LIST_LIMIT,
        });

        if (result.runs.length === 0) {
          return {
            reply:
              status === undefined || status.length === 0
                ? 'No runs yet.'
                : `No runs with status \`${status}\`.`,
          };
        }

        const header = `**${result.total} run${result.total === 1 ? '' : 's'}**${
          status === undefined || status.length === 0 ? '' : ` with status \`${status}\``
        }`;
        const body = render(result.runs, (r) => `\`${r.id.slice(0, 8)}\` — ${r.status} · ${r.kind}`);
        return { reply: `${header}\n\n${body}` };
      },
    },

    {
      name: 'tools',
      usage: '/tools',
      description: 'List the tools the engine can call',
      async run(): Promise<{ reply: string }> {
        const tools = await services.tools.list(ctx.tenantId);
        const enabled = tools.filter((t) => t.status === 'enabled');
        if (tools.length === 0) return { reply: 'No tools registered yet.' };
        return {
          reply:
            `**${enabled.length} of ${tools.length} tools enabled**\n\n` +
            render(enabled, (t) => `\`${t.id}\` — ${t.name}`),
        };
      },
    },

    {
      name: 'mcp',
      usage: '/mcp',
      description: 'List your MCP servers and their connection state',
      async run(): Promise<{ reply: string }> {
        const servers = await services.mcp.list(ctx.tenantId);
        if (servers.length === 0) return { reply: 'No MCP servers configured yet.' };
        return { reply: render(servers, (s) => `\`${s.id}\` — ${s.name} · ${s.status}`) };
      },
    },

    {
      name: 'skills',
      usage: '/skills',
      description: 'List installed skills',
      async run(): Promise<{ reply: string }> {
        // The `Skill` and `SkillVersion` tables exist — a versioned prompt template plus an args
        // schema — but no repository reads them and nothing can be installed yet, so there is no
        // honest row to list. v2 §7 gives an installed skill a dynamic `/skill <name>` command on
        // every surface; that is the shape this takes.
        return {
          reply:
            'Nothing installed yet. v2 §7 gives skills a Hub: versioned `SKILL.md` packs that ' +
            'install as `/skill <name>` on every surface. Until the Hub lands, `/tools` and ' +
            '`/mcp` are what the engine can call.',
        };
      },
    },
  ];
}

/**
 * Render a list, capped, with an honest tail.
 *
 * The cap is not cosmetic: `/runs` on a busy tenant would otherwise paste thousands of lines
 * into a message that is itself stored in the database and re-sent to a model on the next turn.
 */
function render<T>(rows: T[], line: (row: T) => string): string {
  const shown = rows.slice(0, LIST_LIMIT).map(line);
  if (rows.length > LIST_LIMIT) {
    shown.push(`… and ${rows.length - LIST_LIMIT} more`);
  }
  return shown.join('\n');
}
