import type { ChatContext, CommandDraft, ParsedArgs } from './types.js';

/**
 * The commands that create things: `/agent`, `/goal`, `/run`.
 *
 * ## Why these exist as commands at all
 *
 * They are the spec's answer to "how does a user get from a sentence to a real row". Asking the
 * model to call a tool would work, but it makes the outcome probabilistic — the model might
 * decide to ask a clarifying question instead. A slash command is deterministic: `/agent Scout
 * "watch Hacker News"` creates an agent, full stop, and the next message can rely on it.
 *
 * ## The event contract
 *
 * §3.8 says `/agent` emits `agent.created`, `/goal` emits `goal.created`, and `/run` emits
 * `task.created` and `run.created`. Those frames are emitted by the **services** — `AgentService`,
 * `GoalService` and `TaskService` already publish them through the container's emitter — so a
 * command does not emit them itself. Doing so here would double every event, and the second one
 * would be a lie about where the write happened.
 */
export function createCreationCommands(_ctx: ChatContext): CommandDraft[] {
  const { services } = _ctx;

  return [
    {
      name: 'agent',
      usage: '/agent <name> <instructions>',
      description: 'Create an active agent with the default model',
      async run(args: ParsedArgs): Promise<{ reply: string }> {
        const name = args.positional[0];
        // Everything after the name is the instruction, joined back together — the parser split
        // it on whitespace, and re-joining is what makes `/agent Scout watch the news` work
        // without quotes while `"…"` still groups it as one token.
        const instructions = args.positional.slice(1).join(' ').trim();

        if (name === undefined || name.length === 0) {
          return { reply: 'Usage: `/agent <name> <instructions>`' };
        }
        if (instructions.length === 0) {
          return {
            reply:
              'An agent needs instructions — they are what it is told to do.\n\n' +
              'Usage: `/agent <name> <instructions>`\n' +
              'Example: `/agent Scout "watch Hacker News and summarise anything about Postgres"`',
          };
        }

        const agent = await services.agents.create(_ctx.tenantId, {
          name,
          description: instructions,
        });

        return {
          reply:
            `Created agent **${agent.name}** (\`${agent.id}\`).\n\n` +
            `Instructions: ${instructions}\n\n` +
            `Start work with \`/run <task> --agent ${agent.name}\`.`,
        };
      },
    },

    {
      name: 'goal',
      usage: '/goal <title> [description]',
      description: 'Create a goal in draft',
      async run(args: ParsedArgs): Promise<{ reply: string }> {
        const title = args.positional[0];
        if (title === undefined || title.length === 0) {
          return { reply: 'Usage: `/goal <title> [description]`' };
        }

        const description = args.positional.slice(1).join(' ').trim();

        const goal = await services.goals.create(_ctx.tenantId, {
          title,
          ...(description.length === 0 ? {} : { description }),
        });

        // Draft, and saying so matters: a goal that looks active but is not being worked on
        // would be the kind of silently-dropped state this codebase avoids everywhere else.
        return {
          reply:
            `Created goal **${goal.title}** (\`${goal.id}\`), in \`${goal.status}\`.\n\n` +
            `Goals start as drafts so their criteria can be set before work begins. ` +
            `Add tasks to it with \`/run <task>\` and give the task this goal's id.`,
        };
      },
    },

    {
      name: 'run',
      usage: '/run <task description> --agent <agentNameOrId>',
      description: 'Create a task and enqueue a run',
      async run(args: ParsedArgs): Promise<{ reply: string }> {
        const title = args.positional.join(' ').trim();
        const agentRef = args.flags.agent;

        if (title.length === 0) {
          return { reply: 'Usage: `/run <task description> --agent <agentNameOrId>`' };
        }
        if (agentRef === undefined || agentRef.length === 0) {
          return {
            reply:
              'A run needs an agent to run as.\n\n' +
              'Usage: `/run <task description> --agent <agentNameOrId>`\n' +
              'Example: `/run "summarise the front page" --agent Scout`',
          };
        }

        // The flag takes a name *or* an id, so resolve a name to an id here rather than making
        // the user look one up. Matching is exact-first, then case-insensitive: an exact match
        // must never lose to a near-miss.
        const agentId = await resolveAgentId(_ctx, agentRef);
        if (agentId === null) {
          const agents = await services.agents.list(_ctx.tenantId);
          const known =
            agents.length === 0
              ? 'You have no agents yet — create one with `/agent <name> <instructions>`.'
              : `Known agents: ${agents.map((a) => a.name).join(', ')}`;
          return { reply: `No agent matches \`${agentRef}\`.\n\n${known}` };
        }

        const task = await services.tasks.create(_ctx.tenantId, {
          title,
          triggerType: 'manual',
          agentId,
        });

        return {
          reply:
            `Created task **${task.title}** (\`${task.id}\`) and queued its run.\n\n` +
            `Watch it with \`/runs\`.`,
        };
      },
    },
  ];
}

/**
 * Resolve an agent by id or name.
 *
 * Returns `null` rather than throwing so the caller can build a helpful reply listing what does
 * exist — which is far more useful than "not found".
 */
async function resolveAgentId(ctx: ChatContext, ref: string): Promise<string | null> {
  const agents = await ctx.services.agents.list(ctx.tenantId);

  const exact = agents.find((a) => a.id === ref || a.name === ref);
  if (exact !== undefined) return exact.id;

  const insensitive = agents.find((a) => a.name.toLowerCase() === ref.toLowerCase());
  return insensitive?.id ?? null;
}
