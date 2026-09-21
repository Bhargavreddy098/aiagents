import type { Logger } from '../../logger.js';
import { createSlashCommands } from './commands/index.js';
import { parseArgs, type ChatContext, type CommandServices } from './commands/types.js';

/**
 * Slash commands, as the chat pipeline sees them (§PHASE-8.3).
 *
 * ## Where this sits in a turn
 *
 * The spec's pipeline is `parse → slash command? handler : …`. This class is that question. A
 * turn whose text starts with `/` is answered by a command and **never reaches the model**: no
 * provider call, no run enqueued for generation, no tokens spent. That is not a shortcut, it is
 * the point of a command — a user typing `/runs` wants the run list, not a model's summary of a
 * run list it was asked to imagine.
 *
 * ## Why the command set is built per call
 *
 * `createSlashCommands` takes the context, and the context contains a tenant. Building the set
 * once at startup would mean one set for every tenant, which is precisely the shape of bug that
 * makes tenant isolation fail quietly. Building it per turn costs a handful of closures and
 * removes the category.
 */

export interface SlashCommandServiceDeps {
  services: CommandServices;
  logger: Logger;
}

export interface CommandOutcome {
  /** The command's reply, to be persisted as an assistant message. */
  reply: string;
  /** The command name, without the slash — for logging and for the client's rendering. */
  command: string;
}

export class SlashCommandService {
  constructor(private readonly deps: SlashCommandServiceDeps) {}

  /**
   * Is this text a command?
   *
   * A leading `/` is the whole test, and it deliberately does **not** require the command to
   * exist: `/typo` must be handled by the dispatcher (which can say "no such command, here is
   * what exists") rather than falling through to the model, which would try to answer it as a
   * question about the word "typo".
   *
   * A bare `/` is not a command — it is a user who has started typing one.
   */
  static isCommand(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.length > 1 && trimmed.startsWith('/');
  }

  /**
   * Run the command in `text`, or return `null` when there is no such command.
   *
   * A command that throws is caught and turned into a reply. The reason is the same one the
   * turn runner uses for tools: this runs on a stream, where a throw has no status code to
   * become, and a user who typed `/approve <id>` for a deleted approval deserves a sentence
   * explaining that — not a truncated stream.
   */
  async run(
    ctx: { tenantId: string; userId: string; sessionId: string },
    text: string,
  ): Promise<CommandOutcome | null> {
    const body = text.trim().slice(1);
    const spaceAt = body.search(/\s/);
    const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
    const rest = spaceAt === -1 ? '' : body.slice(spaceAt);

    if (name.length === 0) return null;

    const context: ChatContext = {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      services: this.deps.services,
    };

    const commands = createSlashCommands(context);
    const command = commands.get(name);

    if (command === undefined) {
      const known = [...commands.keys()].sort().map((n) => `\`/${n}\``).join(', ');
      return {
        command: name,
        reply: `No command called \`/${name}\`.\n\nAvailable: ${known}`,
      };
    }

    this.deps.logger.info({ tenantId: ctx.tenantId, command: name }, 'running slash command');

    try {
      const result = await command.run(parseArgs(rest), context);
      return { command: name, reply: result.reply };
    } catch (err) {
      this.deps.logger.warn({ err, tenantId: ctx.tenantId, command: name }, 'slash command failed');
      return {
        command: name,
        reply:
          `\`/${name}\` failed: ${err instanceof Error ? err.message : String(err)}\n\n` +
          `Nothing was changed if the failure happened before the write.`,
      };
    }
  }
}
