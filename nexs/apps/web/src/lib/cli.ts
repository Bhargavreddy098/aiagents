/**
 * The terminal's command language, as data and as pure functions.
 *
 * ## What this terminal is, stated before anything else
 *
 * It **evaluates JavaScript**. It is not a POSIX shell, and the single most important decision
 * in this file is that it does not pretend to be one.
 *
 * The only execution path this product has is `POST /sandbox/:id/exec`, whose schema is
 * `{ code, input?, timeoutMs?, maxOutputBytes? }` and whose provider evaluates JavaScript in a
 * worker. There is no `ls`, no `cd`, no pipes and no shell — `!command` is refused by name in the
 * composer for exactly this reason, with the sentence "This deployment has no operator shell;
 * use a Sandbox session".
 *
 * So a terminal that accepted `ls -la` and printed a plausible directory listing would be the
 * worst kind of lie: not a missing feature but a *fabricated* one, and one that would look
 * correct until someone relied on it. A bare line is JavaScript. Anything that looks like a shell
 * command is passed to the evaluator unchanged and fails there, honestly, with the engine's own
 * error — which is the same behaviour a real JS REPL has.
 *
 * ## The one rewrite, and why it is not a lie
 *
 * The engine evaluates a snippet as a function body, so `1 + 1` evaluates and discards. A line
 * that is a single expression is therefore wrapped in `return (…)` before it is sent — see
 * `prepareCode`, which is where the decision and its reasoning live. The transcript prints the
 * line as typed, the banner states the rule, and the wrapper is a compile-time syntax check
 * rather than a guess, so nothing is hidden and no shell word is ever reinterpreted.
 *
 * ## Why the command table is data
 *
 * `/help` renders from `CLI_COMMANDS` and the parser matches against the same list, so help
 * cannot advertise a command that does not exist and a command cannot exist without appearing in
 * help. `cli.test.ts` asserts both directions, because a help screen that lies is the failure
 * this whole file is arranged to prevent.
 */

/** A verb the terminal handles itself, rather than handing to the evaluator. */
export interface CliCommandSpec {
  /** Matched after the leading `/`, case-insensitively. */
  name: string;
  /** How it is written on screen. */
  usage: string;
  summary: string;
  /** What the argument is, when the verb takes one. */
  arg?: string;
}

/**
 * The verbs, in the order `/help` prints them.
 *
 * Every one of them is implemented. There is no "planned" row: a documented command that does
 * nothing is the same lie as a fabricated `ls`.
 */
export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    name: 'help',
    usage: '/help',
    summary: 'List these commands.',
  },
  {
    name: 'clear',
    usage: '/clear',
    summary: 'Empty the screen. `Ctrl+L` does the same.',
  },
  {
    name: 'new',
    usage: '/new',
    summary: 'Open a fresh sandbox session and run in it.',
  },
  {
    name: 'sessions',
    usage: '/sessions',
    summary: 'List the sandbox sessions this workspace has.',
  },
  {
    name: 'use',
    usage: '/use <session-id>',
    summary: 'Run in an existing session instead of the current one.',
    arg: 'session-id',
  },
];

/** Everything a line can mean. */
export type CliCommand =
  | { kind: 'empty' }
  /** A line that is not a verb. It goes to the evaluator as JavaScript, verbatim. */
  | { kind: 'eval'; code: string }
  /** A verb that does not exist. Answered with the list, not with a guess at what was meant. */
  | { kind: 'unknown'; word: string }
  /** A real verb used without the argument it requires. */
  | { kind: 'usage'; verb: string; arg: string }
  | { kind: 'help' }
  | { kind: 'clear' }
  | { kind: 'new' }
  | { kind: 'sessions' }
  | { kind: 'use'; id: string };

/**
 * Read one line.
 *
 * The only syntax is the leading `/`. Everything else — including a line that begins with a
 * word that looks like a shell builtin — is JavaScript. That is a deliberate refusal to guess:
 * a parser clever enough to route `ls` somewhere would be a parser that silently reinterprets
 * someone's JavaScript, and `"use strict"` is a legal JavaScript statement that starts with a
 * letter and a space.
 */
export function parseCommand(line: string): CliCommand {
  const trimmed = line.trim();
  if (trimmed === '') return { kind: 'empty' };
  if (!trimmed.startsWith('/')) return { kind: 'eval', code: line };

  // `/use abc` → verb `use`, rest `abc`. Split on the first run of whitespace so an argument can
  // contain spaces without needing quotes.
  const body = trimmed.slice(1);
  const match = /^(\S+)\s*(.*)$/.exec(body);
  if (match === null) return { kind: 'empty' };

  const word = match[1]!.toLowerCase();
  const rest = match[2]!.trim();
  const spec = CLI_COMMANDS.find((entry) => entry.name === word);
  if (spec === undefined) return { kind: 'unknown', word };

  if (spec.arg !== undefined) {
    return rest === '' ? { kind: 'usage', verb: word, arg: spec.arg } : { kind: 'use', id: rest };
  }

  // A verb with no argument that was given one: `sessions` takes none, and quietly ignoring the
  // extra words would leave a typo looking like it worked.
  if (rest !== '') return { kind: 'usage', verb: word, arg: 'no arguments' };

  if (word === 'help') return { kind: 'help' };
  if (word === 'clear') return { kind: 'clear' };
  if (word === 'new') return { kind: 'new' };
  return { kind: 'sessions' };
}

/**
 * The code that is actually evaluated, and whether it was rewritten to get a value out.
 *
 * ## Why a line gets wrapped
 *
 * The sandbox runs a snippet as an async **function body** — `new AsyncFunction(…, '"use strict";\n'
 * + code)` — so a bare expression is evaluated and then thrown away. `1 + 1` prints nothing at
 * all. That is defensible for the agent's tool, where the snippet is expected to `return` its
 * result, and indefensible for a terminal: the first thing anyone types is an expression, and a
 * terminal that answers the first thing you type with silence is one nobody types into twice.
 *
 * So a line that is a single expression is wrapped in `return (…)` — the same implicit print a
 * REPL gives you, and the reason `{ a: 1 }` works here and would otherwise be a syntax error.
 *
 * ## The test is a compile, not a guess
 *
 * A constructor compiles a body without running it, so asking it to compile `return (<line>);`
 * is a **syntax** check with no side effects. If that throws, the line is a statement
 * (`const x = 1`, a loop, a `return` of its own) and is sent verbatim.
 *
 * It is the **async** constructor, the same one the sandbox uses. A plain `Function` body is not
 * an async context, so `await fetch(…)` would fail the check and be sent as a statement — a
 * legal line whose value was silently dropped, which is the exact bug this function exists to
 * fix. The check has to compile in the language the run happens in.
 *
 * ## What it must never do
 *
 * It only ever *adds* `return (…)` around the line. It never rewrites, reorders or reinterprets
 * it — the line inside the wrapper is byte-for-byte what was typed. That matters because
 * `ls -la` is, to JavaScript, the expression `ls - la`: subtraction of two identifiers. So it
 * *is* wrapped, and it still fails in the engine with `ReferenceError: ls is not defined`, which
 * is the right answer. A wrapper that recognised it as a shell word and answered it would be the
 * fabricated shell this file exists to refuse; a wrapper that passes it through unchanged except
 * for a `return` cannot be, whatever the line is.
 *
 * The `\n` around the line are load-bearing: they keep a trailing `//` comment on its own line,
 * so `1 + 1 // sum` still compiles to a returned `2` instead of the `)` being commented out.
 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>;

export function prepareCode(code: string): { code: string; returned: boolean } {
  const trimmed = code.trim();
  if (trimmed === '') return { code, returned: false };
  try {
    // Compiles only. Nothing here executes the body. Async, because the engine's body is async
    // and `await something` is therefore a legal expression *here* — checking with a plain
    // `Function` would call it a statement and silently drop its value.
    new AsyncFunction(`return (\n${trimmed}\n);`);
  } catch {
    return { code, returned: false };
  }
  return { code: `return (\n${trimmed}\n);`, returned: true };
}

/** How many lines of history are kept. A terminal that grows without bound is a leak. */
export const HISTORY_LIMIT = 100;

/**
 * Append a line to the history.
 *
 * Three rules, all of them what a shell does: blank lines are not remembered, an immediate
 * repeat is collapsed (holding Enter must not fill the buffer with one command), and the list is
 * capped from the front so the oldest entry is the one that goes.
 */
export function pushHistory(history: readonly string[], line: string): readonly string[] {
  const entry = line.trim();
  if (entry === '') return history;
  if (history[history.length - 1] === entry) return history;
  const next = [...history, entry];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/**
 * Where the arrow keys can reach.
 *
 * The index runs from `0` to `history.length` **inclusive**, and the extra slot is the draft: it
 * is what `↓` returns you to, and it is why pressing `↓` past the newest command restores what
 * you were typing rather than the newest command again. Clamped at both ends rather than
 * wrapping — a shell that wrapped from the oldest command to the newest would make `↑` held down
 * feel like it had lost its place.
 */
export function stepHistory(index: number, delta: number, length: number): number {
  if (length === 0) return 0;
  const next = index + delta;
  if (next < 0) return 0;
  if (next > length) return length;
  return next;
}

/**
 * The text the prompt should hold for a given history index.
 *
 * `draft` is what the prompt shows at the draft slot — index `history.length`. It is a parameter
 * rather than a read of the live input because those two are **not** the same thing: the caller
 * has to pass the draft it *stashed on the way into* the history, not the line currently on
 * screen. Passing the live input would make `↓` return the command you just recalled instead of
 * the half-typed line you left behind.
 */
export function historyAt(
  history: readonly string[],
  index: number,
  draft: string,
): string {
  return index >= history.length ? draft : (history[index] ?? draft);
}

/** The prompt itself. `session` is `null` before anything has run. */
export function promptFor(session: string | null): string {
  return session === null ? 'nexs:~$' : `nexs:${session.slice(0, 7)}$`;
}

/**
 * The banner, printed once when the terminal opens.
 *
 * It says what the terminal *is* before it says how to use it, because the first thing anyone
 * will type is `ls` and the first thing they need to know is why that is not a shell command
 * here.
 */
export const CLI_BANNER: readonly string[] = [
  'NEXS terminal — evaluates JavaScript in a sandbox session.',
  'It is not a POSIX shell: there is no `ls`, no `cd` and no pipes. A bare line is JavaScript.',
  'A line that is a single expression is returned for you — `1 + 1` prints 2.',
  'A statement is not: write `return` when you want the value of one.',
  'Code runs through the same provider, timeout ceiling and output cap the agent’s tool uses.',
  'Type /help for the commands that are real.',
];
