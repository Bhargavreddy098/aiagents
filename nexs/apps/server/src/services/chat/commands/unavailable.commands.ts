import type { CommandDraft } from './types.js';

/**
 * Commands whose backing feature does not exist yet — §3.8's three, plus v2 §9's additions.
 *
 * Both specs list these, so a user will type them. Omitting them would make the parser answer
 * "unknown command", which is a *false* statement: `/research` is a real command this build has
 * not reached, and "unknown" conflates "you typed it wrong" with "not built".
 *
 * Each names what will back it and nothing else — no fabricated project id, no invented
 * schedule. The two honesty rules this codebase runs on ("every number traces to a DB row",
 * "only the gateway/MCP/files services touch the outside world") both forbid the alternative,
 * and a test asserts the reply contains neither `prj_` nor the word "created" so this file
 * cannot drift into claiming work it did not do.
 *
 * "(not yet available)" is appended **once**, by the mapper at the bottom, rather than written
 * into thirty descriptions — the difference between one place to change and thirty.
 */

interface Pending {
  name: string;
  usage: string;
  description: string;
  /** What will back it, in a clause. Written for a user, not a maintainer. */
  detail: string;
  /** Which work lands it, so the reply can say when rather than only "no". */
  phase: string;
  /** §5.2/S6: owner-only where the command changes the gateway rather than the workspace. */
  adminOnly?: boolean;
  /** Narrower than every client class, where the command only makes sense somewhere. */
  surfaces?: CommandDraft['surfaces'];
}

const PENDING: Pending[] = [
  // ─ the §3.8 originals ────────────────────────────────────────────────────
  {
    name: 'schedule',
    usage: '/schedule <cron-or-in-2h> <task description>',
    description: 'Create a schedule and its target task',
    detail:
      'Until then, a task made with `/run` runs immediately and there is no recurrence to attach.',
    phase: 'the scheduling work',
  },
  {
    name: 'research',
    usage: '/research <question>',
    description: 'Open a research project and gather sources',
    detail:
      'Until then, ask the question as a normal message — the agent answers it, but the sources ' +
      'it finds are not collected into a project with findings.',
    phase: 'the research work',
  },
  {
    name: 'connect',
    usage: '/connect <providerType>',
    description: 'Guided provider setup',
    detail:
      'Until then, add a provider key on the Providers page; the models it exposes appear in ' +
      '`/models` as soon as it syncs.',
    phase: 'the connectors work',
  },

  // ── v2 §9 · mid-run controls (H13/H4) ─────────────────────────────────────
  {
    name: 'steer',
    usage: '/steer <note>',
    description: 'Send a note into the turn already running',
    detail: 'The note has to arrive between tool calls, which the engine does not do yet.',
    phase: 'the engine work',
  },
  {
    name: 'queue',
    usage: '/queue <prompt>',
    description: 'Queue the next prompt behind the running one',
    detail: 'A queued turn needs a durable backlog; the turn runner holds one turn at a time.',
    phase: 'the chat-runner work',
  },
  {
    name: 'btw',
    usage: '/btw <note>',
    description: 'Add a side note without interrupting the run',
    detail: 'This is `/steer` with a softer delivery guarantee, and lands with it.',
    phase: 'the engine work',
  },
  {
    name: 'bg',
    usage: '/bg <task description>',
    description: 'Start work in the background and keep chatting',
    detail:
      'Runs already execute off the chat turn; what is missing is the hand-off that says so.',
    phase: 'the runs work',
  },
  {
    name: 'handoff',
    usage: '/handoff <channel>',
    description: 'Continue this conversation on another surface',
    detail:
      'The session already records where it started; there is nowhere to hand it to until a ' +
      'channel is connected.',
    phase: 'the channels work',
    surfaces: ['web', 'cli', 'tui'],
  },

  // ── v2 §9 · context and configuration ────────────────────────────────────
  {
    name: 'context',
    usage: '/context',
    description: 'Show which context files loaded, and what they cost',
    detail: 'This answers "why was my file ignored?", so it needs the persona files to exist.',
    phase: 'the persona work',
  },
  {
    name: 'config',
    usage: '/config [key] [value]',
    description: 'Read or change workspace configuration',
    detail: 'Reading is safe; writing from a chat message needs the settings audit trail.',
    phase: 'the operations work',
    adminOnly: true,
  },
  {
    name: 'egress',
    usage: '/egress',
    description: 'Show what this agent is allowed to reach',
    detail:
      'Outbound policy is enforced by the tool allowlist today; there is nothing yet to list.',
    phase: 'the security work',
  },
  {
    name: 'heartbeat',
    usage: '/heartbeat <interval>',
    description: 'Re-run this prompt on an interval, for this session',
    detail:
      'A session-scoped timer is not durable; durable recurrence is what `/schedule` is for.',
    phase: 'the scheduling work',
  },
  {
    name: 'loop',
    usage: '/loop <n> <prompt>',
    description: 'Repeat this prompt a bounded number of times',
    detail: 'A bounded loop needs the engine to accept a repeat count without writing a new plan.',
    phase: 'the engine work',
  },
  {
    name: 'refine',
    usage: '/refine <skill name>',
    description: 'Turn what just worked into a reusable skill',
    detail: 'A skill is a versioned prompt template plus an args schema; neither exists yet.',
    phase: 'the skills work',
  },
  {
    name: 'review',
    usage: '/review [runId]',
    description: 'Summarise a run’s steps, receipts and verifications',
    detail: 'Every one of those rows exists — this is the run detail view in message form.',
    phase: 'the observability work',
  },
  {
    name: 'moa',
    usage: '/moa <question>',
    description: 'Answer with several models and reconcile them',
    detail: 'Mixture-of-agents needs fan-out in the gateway and a reconciliation step.',
    phase: 'the gateway work',
    adminOnly: true,
  },

  // ── v2 §9 · session management ───────────────────────────────────────────
  {
    name: 'new',
    usage: '/new',
    description: 'Start a new conversation',
    detail: 'Sessions are rows; what is missing is the client route that swaps between them.',
    phase: 'the frontend work',
  },
  {
    name: 'history',
    usage: '/history [n]',
    description: 'Show the last n messages',
    detail: 'The messages are stored and `GET /api/chat/messages` serves them; this prints them.',
    phase: 'the chat work',
  },
  {
    name: 'title',
    usage: '/title <text>',
    description: 'Name this conversation',
    detail: 'The session has a title column; no service method writes it yet.',
    phase: 'the chat work',
  },
  {
    name: 'save',
    usage: '/save',
    description: 'Export this conversation',
    detail: 'An export is a file, and files go through the one service permitted to touch disk.',
    phase: 'the files work',
  },
  {
    name: 'retry',
    usage: '/retry',
    description: 'Ask again without retyping',
    detail: 'A retry must not create a second task for one intent, so it needs the run link.',
    phase: 'the chat work',
  },
  {
    name: 'undo',
    usage: '/undo',
    description: 'Undo the last change this conversation made',
    detail:
      'Undo needs an inverse for every side effect, which the action ledger does not carry yet.',
    phase: 'the engine work',
  },
  {
    name: 'compress',
    usage: '/compress',
    description: 'Compress this conversation’s context',
    detail:
      'The gateway already truncates and summarises on overflow; doing it on demand is next.',
    phase: 'the gateway work',
  },
  {
    name: 'snapshot',
    usage: '/snapshot',
    description: 'Save a restore point',
    detail: 'A snapshot is a labelled checkpoint; runs have checkpoints, sessions do not.',
    phase: 'the engine work',
  },
  {
    name: 'diff',
    usage: '/diff [snapshot]',
    description: 'Show what changed since a snapshot',
    detail: 'A diff needs two snapshots and a comparable representation of workspace state.',
    phase: 'the engine work',
  },
  {
    name: 'rollback',
    usage: '/rollback <snapshot>',
    description: 'Return to a snapshot',
    detail:
      'Rolling back a side effect that already reached the outside world is not always possible, ' +
      'so this needs the action ledger to say which ones are — and it is owner-only for the same ' +
      'reason.',
    phase: 'the engine work',
    adminOnly: true,
  },
  {
    name: 'branch',
    usage: '/branch [title]',
    description: 'Fork this conversation into a new one',
    detail: 'A branch is a new session seeded with this transcript; there is no fork method yet.',
    phase: 'the chat work',
  },
  {
    name: 'skill',
    usage: '/skill <name> [args]',
    description: 'Run an installed skill',
    detail:
      'v2 makes every installed skill a dynamic command; until one can be installed there is ' +
      'nothing to run.',
    phase: 'the skills work',
  },
];

export const unavailableCommands: CommandDraft[] = PENDING.map((pending) => ({
  name: pending.name,
  usage: pending.usage,
  description: `${pending.description} (not yet available)`,
  adminOnly: pending.adminOnly ?? false,
  ...(pending.surfaces === undefined ? {} : { surfaces: pending.surfaces }),
  async run(): Promise<{ reply: string }> {
    return {
      reply:
        `\`/${pending.name}\` is not available in this build yet.\n\n` +
        `${pending.detail}\n\n_Arrives with ${pending.phase}._`,
    };
  },
}));
