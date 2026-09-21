/**
 * The slash-command catalog and the composer's parser.
 *
 * ## Why the catalog is a client-side mirror, and what that costs
 *
 * The authoritative command table is built per tenant inside
 * `services/chat/commands/index.ts`, and it is **not exposed over HTTP** — there is no
 * `GET /api/chat/commands`. The one place the server will describe it is the `/help` reply,
 * which is markdown written for a human.
 *
 * So this list mirrors the server's modules. That is a real duplication and it is stated
 * rather than hidden. What keeps it honest:
 *
 *  - **The menu is a convenience, never a gate.** Typing a command that is not in this list
 *    still works: the text is sent and the server dispatches it. A stale entry here cannot
 *    stop a command from running.
 *  - **A wrong entry cannot produce a wrong answer.** Selecting an entry inserts text; the
 *    reply always comes from the server, built from real rows.
 *  - **`available` is marked, not hidden.** The server registers ~30 commands whose backing
 *    feature has not landed — `/research`, `/schedule`, `/loop` and the rest. They answer "not
 *    available in this build yet". Offering them unmarked in a menu would be a menu that lies
 *    about what it can do; omitting them would hide commands the spec names. So they are
 *    listed and labelled, and the label comes from the same fact the reply states.
 *
 * `/help` remains the authority on what exists. This list is what makes the menu usable
 * before the user has run it.
 *
 * ## Why this module is pure
 *
 * `parseComposerInput`, `activeSlashQuery` and `filterCommands` take strings and return values
 * — no React, no fetch, no clock. Phase 14 calls for unit tests over the slash parser, and a
 * parser that can only be exercised through a mounted composer is a parser whose edge cases
 * go untested. The rule here is the same one the approval drawer follows: the logic lives
 * where it can be tested directly.
 */

import { ALL_COMMAND_SURFACES, type CommandSurface } from '@nexs/shared';

export interface ComposerCommand {
  /** Without the leading slash. */
  name: string;
  /** The `<>`-convention usage line, as the server's own `/help` prints it. */
  usage: string;
  description: string;
  /**
   * False for a command the server registers but cannot yet run.
   *
   * Every one of these answers with the sentence "…is not available in this build yet",
   * naming the phase that lands it. Marking them here is the client agreeing with the server
   * rather than guessing.
   */
  available: boolean;
  /** Owner-only (`operator.admin`) — the commands that change the gateway, not the workspace. */
  adminOnly: boolean;
  surfaces: readonly CommandSurface[];
}

/**
 * Mirrors `identity`, `registry`, `create`, `control` and `unavailable` command modules.
 *
 * Ordering here is alphabetical, which is what the menu sorts to anyway; grouping would
 * imply a structure the server does not have.
 */
export const SLASH_COMMANDS: readonly ComposerCommand[] = [
  { name: 'agent', usage: '/agent <name> <instructions>', description: 'Create an active agent with the default model', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'agents', usage: '/agents', description: 'List your agents', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'approve', usage: '/approve <approvalId>', description: 'Approve a pending approval, same as the inbox button', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'bg', usage: '/bg <task description>', description: 'Start work in the background and keep chatting (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'branch', usage: '/branch [title]', description: 'Fork this conversation into a new one (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'browser', usage: '/browser <url> <screenshot|title|text>', description: 'Read a page in a headless browser', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'btw', usage: '/btw <note>', description: 'Add a side note without interrupting the run (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'clear', usage: '/clear', description: 'Clear the composer (client-side)', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'compress', usage: '/compress', description: 'Compress this conversation’s context (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'config', usage: '/config [key] [value]', description: 'Read or change workspace configuration (not yet available)', available: false, adminOnly: true, surfaces: ALL_COMMAND_SURFACES },
  { name: 'connect', usage: '/connect <providerType>', description: 'Guided provider setup (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'context', usage: '/context', description: 'Show which context files loaded, and what they cost (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'diff', usage: '/diff [snapshot]', description: 'Show what changed since a snapshot (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'egress', usage: '/egress', description: 'Show what this agent is allowed to reach (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'goal', usage: '/goal <title> [description]', description: 'Create a goal in draft', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'goals', usage: '/goals', description: 'List your goals', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'handoff', usage: '/handoff <channel>', description: 'Continue this conversation on another surface (not yet available)', available: false, adminOnly: false, surfaces: ['web', 'cli', 'tui'] },
  { name: 'heartbeat', usage: '/heartbeat <interval>', description: 'Re-run this prompt on an interval, for this session (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'help', usage: '/help', description: 'List every command you can run', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'history', usage: '/history [n]', description: 'Show the last n messages (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'loop', usage: '/loop <n> <prompt>', description: 'Repeat this prompt a bounded number of times (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'mcp', usage: '/mcp', description: 'List your MCP servers and their connection state', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'moa', usage: '/moa <question>', description: 'Answer with several models and reconcile them (not yet available)', available: false, adminOnly: true, surfaces: ALL_COMMAND_SURFACES },
  { name: 'models', usage: '/models', description: 'List the models in your catalog', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'mouse', usage: '/mouse [on|off|wheel|buttons|all]', description: 'Configure terminal mouse tracking (not yet available — a browser tab owns the pointer)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'new', usage: '/new [name]', description: 'Start a new conversation (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'pause', usage: '/pause <runId>', description: 'Pause a run', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'personality', usage: '/personality <name>', description: 'Switch the active persona (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'queue', usage: '/queue <prompt>', description: 'Queue the next prompt behind the running one (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'redraw', usage: '/redraw', description: 'Force a screen redraw (not yet available — a page repaints itself)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'refine', usage: '/refine <skill name>', description: 'Turn what just worked into a reusable skill (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'reject', usage: '/reject <approvalId>', description: 'Reject a pending approval, same as the inbox button', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'research', usage: '/research <question>', description: 'Open a research project and gather sources (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'resume', usage: '/resume <runId>', description: 'Resume a paused run', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'retry', usage: '/retry', description: 'Ask again without retyping (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'review', usage: '/review [runId]', description: 'Summarise a run’s steps, receipts and verifications (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'rollback', usage: '/rollback <snapshot>', description: 'Return to a snapshot (not yet available)', available: false, adminOnly: true, surfaces: ALL_COMMAND_SURFACES },
  { name: 'run', usage: '/run <task description> --agent <agentNameOrId>', description: 'Create a task and enqueue a run', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'runs', usage: '/runs [status]', description: 'List recent runs, optionally filtered by status', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'save', usage: '/save', description: 'Export this conversation (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'schedule', usage: '/schedule <cron-or-in-2h> <task description>', description: 'Create a schedule and its target task (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'skill', usage: '/skill <name> [args]', description: 'Run an installed skill (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'skills', usage: '/skills', description: 'List installed skills', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'skin', usage: '/skin <name>', description: 'Switch the theme (not yet available — one theme is shipped)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'snapshot', usage: '/snapshot', description: 'Save a restore point (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'status', usage: '/status', description: 'Provider health, running runs, and pending approvals', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'steer', usage: '/steer <note>', description: 'Send a note into the turn already running (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'stop', usage: '/stop <runId>', description: 'Cancel a run', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'title', usage: '/title <text>', description: 'Name this conversation (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'tools', usage: '/tools', description: 'List the tools the engine can call', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'undo', usage: '/undo', description: 'Undo the last change this conversation made (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'usage', usage: '/usage', description: 'Token statistics, cache hits and spend (not yet available)', available: false, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
  { name: 'whoami', usage: '/whoami', description: 'Show who the gateway thinks you are, and what you may run', available: true, adminOnly: false, surfaces: ALL_COMMAND_SURFACES },
];

/** What the composer's text means. */
export type ComposerInput =
  | { kind: 'empty' }
  | { kind: 'command'; name: string; args: string }
  | { kind: 'message'; text: string };

/**
 * Classify the composer's text.
 *
 * Mirrors `SlashCommandService.isCommand` exactly, including the part that looks like an
 * oversight: a **bare `/` is not a command**. It is a user who has started typing one, and
 * classifying it as a command would send `/` to the server, which would answer "no command
 * called ``". The client holds that state instead so the menu can open.
 *
 * A leading `/` is the whole test — the command does not have to exist. `/typo` must reach the
 * server, which answers with the list of real commands; answering it locally would mean two
 * implementations of "what commands exist".
 */
export function parseComposerInput(text: string): ComposerInput {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: 'empty' };
  if (trimmed.length === 1 && trimmed === '/') return { kind: 'message', text: trimmed };

  if (trimmed.startsWith('/')) {
    const body = trimmed.slice(1);
    const spaceAt = body.search(/\s/);
    const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
    if (name.length > 0) {
      return { kind: 'command', name, args: spaceAt === -1 ? '' : body.slice(spaceAt).trim() };
    }
  }

  return { kind: 'message', text: text.trim() };
}

/** The region of the text a `/` completion would replace. */
export interface CompletionRange {
  /** The text typed after the slash, to match against. */
  query: string;
  /** Index of the `/`. */
  start: number;
  /** Index just past the last typed character. */
  end: number;
}

/**
 * The slash command being typed, or `null`.
 *
 * The slash must begin the **message**, not merely a word. That is not a style choice: the
 * server's `SlashCommandService.isCommand` is `trimmed.startsWith('/')`, so a slash anywhere
 * else is prose — `/etc/hosts`, `and/or`, a path in a sentence — and a menu appearing there
 * would offer commands that cannot run. A completion that inserts text the server then treats
 * as a question is worse than no completion.
 *
 * The `caret` argument is required rather than assumed to be the end of the string: the user
 * can click back into the middle of the text, and completing against the end of the string
 * would insert the command in the wrong place.
 */
export function activeSlashQuery(text: string, caret: number): CompletionRange | null {
  const upto = text.slice(0, caret);
  const slashAt = upto.lastIndexOf('/');
  if (slashAt === -1) return null;

  // Anything but whitespace before the slash means this is not a command line.
  if (text.slice(0, slashAt).trim().length > 0) return null;

  const query = upto.slice(slashAt + 1);
  // Whitespace after the slash means the command name is finished and this is now arguments.
  if (/\s/.test(query)) return null;

  return { query, start: slashAt, end: caret };
}

/**
 * Commands matching what has been typed.
 *
 * Prefix matches come first, then substring matches, each group alphabetical. A prefix match is
 * what the user is almost always doing — `/st` is `/status`, not `/stop` and not `/status`
 * ranked below something that merely contains "st". Ordering by "does the name start with this"
 * before falling back to "does anything match" gives that without a scoring function whose
 * output nobody can predict.
 */
export function filterCommands(query: string, catalog: readonly ComposerCommand[] = SLASH_COMMANDS): ComposerCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...catalog];

  const prefix: ComposerCommand[] = [];
  const rest: ComposerCommand[] = [];

  for (const command of catalog) {
    if (command.name.startsWith(needle)) {
      prefix.push(command);
    } else if (command.name.includes(needle) || command.description.toLowerCase().includes(needle)) {
      rest.push(command);
    }
  }

  return [...prefix, ...rest];
}

/**
 * The text a completed command replaces its range with.
 *
 * No trailing space here: `applyCompletion` puts one after whatever it inserts, and a space in
 * both places would leave the user typing after two of them.
 */
export function completeCommand(command: ComposerCommand): string {
  return `/${command.name}`;
}
