/**
 * The terminal's command language.
 *
 * The most important assertion in this file is the one that says a shell command is *not*
 * recognised. `parseCommand('ls -la')` returning `{ kind: 'eval' }` is the whole honesty
 * position of the feature written down as a test: the terminal evaluates JavaScript, so `ls` is
 * a reference error in the sandbox rather than a fabricated directory listing. If someone ever
 * "improves" this by routing shell words somewhere, that test fails and the argument above it is
 * the reason.
 *
 * The second theme is agreement between the two halves of the command table: `/help` renders
 * from `CLI_COMMANDS` and the parser matches against it, so a command cannot exist without being
 * documented, or be documented without existing.
 */

import { describe, expect, it } from 'vitest';
import {
  CLI_BANNER,
  CLI_COMMANDS,
  HISTORY_LIMIT,
  historyAt,
  parseCommand,
  prepareCode,
  promptFor,
  pushHistory,
  stepHistory,
} from './cli';

describe('parseCommand', () => {
  it('treats a blank line as nothing to do', () => {
    expect(parseCommand('')).toEqual({ kind: 'empty' });
    expect(parseCommand('   \t ')).toEqual({ kind: 'empty' });
  });

  it('sends a bare line to the evaluator unchanged', () => {
    expect(parseCommand('1 + 1')).toEqual({ kind: 'eval', code: '1 + 1' });
    // Unchanged, including the original spacing — the evaluator sees what was typed.
    expect(parseCommand('  const x = 2; x * 3  ')).toEqual({
      kind: 'eval',
      code: '  const x = 2; x * 3  ',
    });
  });

  it('does not pretend to be a shell', () => {
    // The position of the whole feature, as an assertion. Each of these is a line somebody will
    // type; each of them is JavaScript here, and each of them fails in the engine with a real
    // message rather than being quietly reinterpreted.
    for (const line of ['ls -la', 'cd /tmp', 'git status', 'cat file.txt', 'echo hi > out.txt']) {
      const parsed = parseCommand(line);
      expect(parsed.kind).toBe('eval');
      expect(parsed).toEqual({ kind: 'eval', code: line });
    }
  });

  it('does not mistake a JavaScript string for a verb', () => {
    // `"use strict"` begins with a letter, and a parser that routed leading words would eat it.
    expect(parseCommand('"use strict"')).toEqual({ kind: 'eval', code: '"use strict"' });
  });

  it('reads the verbs', () => {
    expect(parseCommand('/help')).toEqual({ kind: 'help' });
    expect(parseCommand('/clear')).toEqual({ kind: 'clear' });
    expect(parseCommand('/new')).toEqual({ kind: 'new' });
    expect(parseCommand('/sessions')).toEqual({ kind: 'sessions' });
    expect(parseCommand('/use abc123')).toEqual({ kind: 'use', id: 'abc123' });
  });

  it('is case-insensitive about the verb, and only the verb', () => {
    expect(parseCommand('/HELP')).toEqual({ kind: 'help' });
    expect(parseCommand('/Use abc')).toEqual({ kind: 'use', id: 'abc' });
  });

  it('refuses an unknown verb instead of guessing at it', () => {
    expect(parseCommand('/ls')).toEqual({ kind: 'unknown', word: 'ls' });
    expect(parseCommand('/clera')).toEqual({ kind: 'unknown', word: 'clera' });
  });

  it('asks for the argument a verb needs', () => {
    expect(parseCommand('/use')).toEqual({ kind: 'usage', verb: 'use', arg: 'session-id' });
    expect(parseCommand('/use   ')).toEqual({ kind: 'usage', verb: 'use', arg: 'session-id' });
  });

  it('refuses arguments a verb does not take', () => {
    // Silently ignoring the extra words would leave a typo looking like it worked.
    expect(parseCommand('/sessions now')).toEqual({ kind: 'usage', verb: 'sessions', arg: 'no arguments' });
  });

  it('keeps an argument that contains spaces together', () => {
    expect(parseCommand('/use a b')).toEqual({ kind: 'use', id: 'a b' });
  });
});

describe('CLI_COMMANDS', () => {
  it('is a table of commands that all parse to a real verb', () => {
    // Documented ⇒ implemented. A verb that needs an argument answers `usage` when called bare,
    // which is still a *recognised* verb — what must never happen is `unknown`, because that is
    // the answer for a command that does not exist.
    for (const spec of CLI_COMMANDS) {
      const parsed = parseCommand(spec.usage.split(' ')[0]!);
      expect(parsed.kind, `${spec.usage} is documented but does not parse`).not.toBe('unknown');
    }
  });

  it('is a table that covers every verb the parser handles', () => {
    // Implemented ⇒ documented. Each name has to reach a *different* outcome, which is what
    // makes "all of them are handled" different from "one of them is handled five times".
    const kinds = CLI_COMMANDS.map((spec) => parseCommand(`/${spec.name}`).kind);
    expect(new Set(kinds).size).toBe(CLI_COMMANDS.length);
  });

  it('gives every command a usage string that starts with its own name', () => {
    for (const spec of CLI_COMMANDS) {
      expect(spec.usage).toBe(`/${spec.name}${spec.arg === undefined ? '' : ` <${spec.arg}>`}`);
      expect(spec.summary.length).toBeGreaterThan(10);
    }
  });

  it('declares an argument for exactly the verbs that refuse to run without one', () => {
    for (const spec of CLI_COMMANDS) {
      const refusesWithoutArg = parseCommand(`/${spec.name}`).kind === 'usage';
      expect(refusesWithoutArg, `${spec.name} disagrees with its own spec`).toBe(
        spec.arg !== undefined,
      );
    }
  });
});

describe('pushHistory', () => {
  it('remembers what was typed', () => {
    expect(pushHistory([], '1 + 1')).toEqual(['1 + 1']);
  });

  it('does not remember blank lines', () => {
    expect(pushHistory(['a'], '   ')).toEqual(['a']);
    expect(pushHistory([], '')).toEqual([]);
  });

  it('collapses an immediate repeat, so holding Enter cannot fill the buffer', () => {
    expect(pushHistory(['a'], 'a')).toEqual(['a']);
    // A repeat that is not immediate is a real command and is kept.
    expect(pushHistory(['a', 'b'], 'a')).toEqual(['a', 'b', 'a']);
  });

  it('trims what it stores', () => {
    expect(pushHistory([], '  x  ')).toEqual(['x']);
  });

  it('drops the oldest entry past the limit', () => {
    let history: readonly string[] = [];
    for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) {
      history = pushHistory(history, `line ${index}`);
    }
    expect(history.length).toBe(HISTORY_LIMIT);
    expect(history[0]).toBe('line 10');
    expect(history[history.length - 1]).toBe(`line ${HISTORY_LIMIT + 9}`);
  });

  it('never mutates the list it was given', () => {
    const original = ['a'];
    pushHistory(original, 'b');
    expect(original).toEqual(['a']);
  });
});

describe('stepHistory', () => {
  it('does nothing with no history', () => {
    expect(stepHistory(0, -1, 0)).toBe(0);
    expect(stepHistory(0, 1, 0)).toBe(0);
  });

  it('stops at the oldest command rather than wrapping', () => {
    expect(stepHistory(1, -1, 3)).toBe(0);
    expect(stepHistory(0, -1, 3)).toBe(0);
  });

  it('reaches the draft slot past the newest command, and stops there', () => {
    // `length` is the draft: the extra slot is what `↓` returns you to.
    expect(stepHistory(2, 1, 3)).toBe(3);
    expect(stepHistory(3, 1, 3)).toBe(3);
  });
});

describe('historyAt', () => {
  it('returns the draft at the draft slot', () => {
    expect(historyAt(['a', 'b'], 2, 'half-typed')).toBe('half-typed');
    expect(historyAt(['a', 'b'], 0, 'half-typed')).toBe('a');
    expect(historyAt(['a', 'b'], 1, 'half-typed')).toBe('b');
  });

  it('falls back to the draft when the index is out of range', () => {
    expect(historyAt([], 0, 'draft')).toBe('draft');
  });
});

describe('promptFor', () => {
  it('shows the session once there is one', () => {
    expect(promptFor(null)).toBe('nexs:~$');
    expect(promptFor('abcdef1234567890')).toBe('nexs:abcdef1$');
  });
});

describe('CLI_BANNER', () => {
  it('says it is not a shell before it says anything else', () => {
    // The first line anyone reads is the one that stops them typing `ls` and concluding the
    // product is broken.
    expect(CLI_BANNER.length).toBeGreaterThan(2);
    expect(CLI_BANNER.join(' ')).toContain('not a POSIX shell');
  });

  it('says which form prints a value and which does not', () => {
    // The engine evaluates a function body, so this is a fact about the terminal that a user
    // cannot guess and will otherwise meet as silence.
    const banner = CLI_BANNER.join(' ');
    expect(banner).toContain('single expression is returned for you');
    expect(banner).toContain('write `return`');
  });
});

describe('prepareCode', () => {
  it('wraps a single expression so the engine returns it', () => {
    const prepared = prepareCode('1 + 1');
    expect(prepared.returned).toBe(true);
    // Evaluated for real, so this is the engine's own answer rather than a string comparison.
    expect(new Function(prepared.code)()).toBe(2);
  });

  it('wraps an object literal, which is a syntax error unwrapped', () => {
    const prepared = prepareCode('{ a: 1 }');
    expect(prepared.returned).toBe(true);
    expect(new Function(prepared.code)()).toEqual({ a: 1 });
  });

  it('leaves a statement alone, because `return (const x = 1);` does not compile', () => {
    for (const statement of ['const x = 1', 'let y = 2; y + 1', 'for (;;) {}', 'return 5']) {
      const prepared = prepareCode(statement);
      expect(prepared.returned).toBe(false);
      expect(prepared.code).toBe(statement);
    }
  });

  it('only ever adds a wrapper, never rewrites the line inside it', () => {
    // The honesty position, stated as an invariant rather than as a list of examples: whatever
    // comes out, stripping the documented wrapper gives back exactly what went in. A wrapper
    // that cannot rewrite a line cannot fabricate an answer for one.
    const inputs = [
      'ls -la',
      'cd /tmp',
      'git status',
      'cat file.txt',
      'echo hi > out.txt',
      'rm -rf /',
      '1 + 1',
      'const x = 1',
      'await fetch("/api/health")',
    ];
    for (const input of inputs) {
      const { code, returned } = prepareCode(input);
      expect(returned ? code.slice('return (\n'.length, -'\n);'.length) : code).toBe(input);
    }
  });

  it('sends a shell word that is not an expression to the engine verbatim', () => {
    // Two adjacent identifiers are a syntax error, so these are statements and pass through
    // untouched — the engine, not the terminal, decides what they mean.
    for (const shellish of ['git status', 'cat file.txt', 'echo hi > out.txt']) {
      const prepared = prepareCode(shellish);
      expect(prepared.returned).toBe(false);
      expect(prepared.code).toBe(shellish);
    }
  });

  it('wraps `ls -la` because JavaScript reads it as subtraction, and it still fails there', () => {
    // Not a shell word to the compiler: `ls - la`. So it is wrapped like any other expression —
    // and the engine's answer is still `ls is not defined`, which is why wrapping it is harmless.
    const prepared = prepareCode('ls -la');
    expect(prepared.returned).toBe(true);
    expect(prepared.code).toContain('ls -la');
    expect(() => new Function(prepared.code)()).toThrow(/ls is not defined/);
  });

  it('does not wrap an empty line', () => {
    expect(prepareCode('')).toEqual({ code: '', returned: false });
    expect(prepareCode('   ')).toEqual({ code: '   ', returned: false });
  });

  it('keeps a trailing comment on its own line, so it cannot swallow the closing paren', () => {
    // This is what the newlines around the line are for. `return (1 + 1 // sum);` would be a
    // syntax error — the `)` inside the comment — but the wrapper puts it on the next line.
    const prepared = prepareCode('1 + 1 // sum');
    expect(prepared.returned).toBe(true);
    expect(new Function(prepared.code)()).toBe(2);
  });

  it('wraps an await, which the engine’s async body makes legal', () => {
    // The check compiles with the async constructor for this reason: a plain `Function` body
    // rejects `await`, which would send this line as a statement and drop its value.
    const prepared = prepareCode('await Promise.resolve(7)');
    expect(prepared.returned).toBe(true);
  });

  it('wraps a call whose return value is undefined without pretending otherwise', () => {
    // `console.log('hi')` is an expression, so it is wrapped — it just returns nothing, and the
    // transcript shows the log rather than a value. Wrapping is about the syntax, not the result.
    const prepared = prepareCode("console.log('hi')");
    expect(prepared.returned).toBe(true);
    expect(new Function(prepared.code)()).toBeUndefined();
  });
});
