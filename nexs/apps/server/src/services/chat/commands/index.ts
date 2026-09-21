import type {
  ChatContext,
  CommandDraft,
  CommandRegistryPolicy,
  SlashCommand,
} from './types.js';
import { DEFAULT_COMMAND_SURFACES, describeCommands, visibleCommands } from './types.js';
import { createRegistryCommands } from './registry.commands.js';
import { createCreationCommands } from './create.commands.js';
import { createControlCommands } from './control.commands.js';
import { createIdentityCommands } from './identity.commands.js';
import { unavailableCommands } from './unavailable.commands.js';

/**
 * The command table (§3.8).
 *
 * ## What is here, and what is deliberately absent
 *
 * Every command in §3.8's table is represented, but not all of them *act*. Eleven are backed by
 * services that exist and produce real output from real rows. Three — `/schedule`, `/research`
 * and `/connect` — name services that arrive in later phases. Those three are present and
 * callable, and they say so rather than pretending; see `unavailable.commands.ts` for why that
 * is better than omitting them.
 *
 * ## Registry, not a switch
 *
 * A `Map` rather than a `switch` for one reason that matters: `/help` must list exactly what
 * can be run. Derived from the same map the dispatcher uses, the help text cannot drift from
 * the implementation — there is no second list to forget to update.
 */
export function createSlashCommands(ctx: ChatContext): Map<string, SlashCommand> {
  // Drafts first, then one pass that fills in the policy defaults. Doing it here rather than in
  // each module means a command that omits `surfaces` cannot silently become unreachable — there
  // is exactly one place the default lives, and it is in front of you.
  const drafts: CommandDraft[] = [
    ...createIdentityCommands(ctx),
    ...createRegistryCommands(ctx),
    ...createCreationCommands(ctx),
    ...createControlCommands(ctx),
    ...unavailableCommands,
  ];

  const byName = new Map<string, SlashCommand>();
  for (const draft of drafts) {
    // A duplicate name would make one of the two unreachable, silently. Failing loudly here is
    // cheap and catches the mistake at the moment it is introduced.
    if (byName.has(draft.name)) {
      throw new Error(`Duplicate slash command: /${draft.name}`);
    }
    byName.set(draft.name, {
      ...draft,
      surfaces: draft.surfaces ?? DEFAULT_COMMAND_SURFACES,
      adminOnly: draft.adminOnly ?? false,
    });
  }

  // Built last, from the table it describes — which is why it lives here and not beside the
  // other listings. A hard-coded help string is the one thing that reliably rots.
  //
  // It is also the one command that applies the caller's policy when *listing* (§9): a menu
  // that offers `/stop` to someone who cannot run it is worse than a menu that omits it.
  byName.set('help', {
    name: 'help',
    usage: '/help',
    description: 'List every command you can run',
    surfaces: DEFAULT_COMMAND_SURFACES,
    adminOnly: false,
    async run(): Promise<{ reply: string }> {
      const policy: CommandRegistryPolicy = ctx.policy ?? { isAdmin: false };
      const rows = describeCommands(visibleCommands([...byName.values()], policy)).map(
        (command) => {
          // §9's two badges: an owner-only marker, and — only when the command is *not*
          // available everywhere — the client classes it is limited to. "Everywhere" is the
          // silent default so the common row stays one line.
          const owner = command.adminOnly ? ' · _owner_' : '';
          const where =
            command.surfaces.length === DEFAULT_COMMAND_SURFACES.length
              ? ''
              : ` · _${command.surfaces.join('/')}_`;
          return `\`${command.usage}\` — ${command.description}${owner}${where}`;
        },
      );
      return { reply: `**Commands**\n\n${rows.join('\n')}` };
    },
  });

  return byName;
}

/**
 * Re-exported so a caller does not need to reach into two modules, and so the *client-facing*
 * descriptor shape has one definition. `describeCommands` now comes from `types.ts` because the
 * palette needs `surfaces`/`adminOnly` and this file is not the only thing that renders a list.
 */
export { describeCommands, visibleCommands };

/** Re-exported so the dispatcher does not need to reach into two modules. */
export type { ChatContext, CommandDraft, CommandRegistryPolicy, SlashCommand };
