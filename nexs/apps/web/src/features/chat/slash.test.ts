/**
 * The slash parser.
 *
 * These are the tests Phase 14 asks for, and they are pure — no DOM, no fetch, no React. The
 * parser is where a bug is silent: a menu that opens when it should not inserts text the server
 * then treats as a question, and nothing errors.
 *
 * The catalog is asserted for integrity rather than for content. A hand-written test listing
 * forty-eight commands would be a second copy of the list that rots; asserting the *properties*
 * the server's own registry enforces — unique names, a usage line that begins with the name —
 * catches the mistakes that matter and survives an edit to the list.
 */

import { describe, expect, it } from 'vitest';
import {
  SLASH_COMMANDS,
  activeSlashQuery,
  completeCommand,
  filterCommands,
  parseComposerInput,
} from './slash';

describe('parseComposerInput', () => {
  it('treats empty and whitespace-only input as empty', () => {
    expect(parseComposerInput('')).toEqual({ kind: 'empty' });
    expect(parseComposerInput('   \n ')).toEqual({ kind: 'empty' });
  });

  it('does not treat a bare slash as a command', () => {
    // The server's `isCommand` requires length > 1. A bare `/` is someone starting to type a
    // command, and sending it would produce "no command called ``".
    expect(parseComposerInput('/')).toEqual({ kind: 'message', text: '/' });
  });

  it('parses a command with no arguments', () => {
    expect(parseComposerInput('/help')).toEqual({ kind: 'command', name: 'help', args: '' });
  });

  it('parses a command with arguments, preserving them verbatim', () => {
    expect(parseComposerInput('/agent Scout "watch Hacker News hourly"')).toEqual({
      kind: 'command',
      name: 'agent',
      args: 'Scout "watch Hacker News hourly"',
    });
  });

  it('lowercases the command name but not its arguments', () => {
    // The server lowercases the name and passes `rest` through untouched, so `/Agent Scout`
    // must dispatch `/agent` and keep `Scout` capitalised.
    expect(parseComposerInput('/Agent Scout')).toEqual({
      kind: 'command',
      name: 'agent',
      args: 'Scout',
    });
  });

  it('accepts a trailing space as an empty argument list', () => {
    expect(parseComposerInput('/agent ')).toEqual({ kind: 'command', name: 'agent', args: '' });
  });

  it('sends an unknown command to the server rather than deciding locally', () => {
    // `/typo` must reach the dispatcher, which answers with the real command list. Deciding
    // "not a command" here would mean two implementations of what exists.
    expect(parseComposerInput('/typo')).toEqual({ kind: 'command', name: 'typo', args: '' });
  });

  it('treats ordinary prose as a message', () => {
    expect(parseComposerInput('  what is a goal?  ')).toEqual({
      kind: 'message',
      text: 'what is a goal?',
    });
  });
});

describe('activeSlashQuery', () => {
  it('opens at the start of the message', () => {
    expect(activeSlashQuery('/he', 3)).toEqual({ query: 'he', start: 0, end: 3 });
  });

  it('opens after leading whitespace, because the server trims before checking', () => {
    expect(activeSlashQuery('  /he', 5)).toEqual({ query: 'he', start: 2, end: 5 });
  });

  it('does not open mid-sentence', () => {
    // The server only dispatches a command when the *message* starts with a slash. A menu here
    // would offer commands that cannot run.
    expect(activeSlashQuery('see /etc/hosts', 14)).toBeNull();
    expect(activeSlashQuery('and/or', 7)).toBeNull();
  });

  it('closes once arguments begin', () => {
    expect(activeSlashQuery('/runs failed', 12)).toBeNull();
  });

  it('returns null when there is no slash at all', () => {
    expect(activeSlashQuery('hello', 5)).toBeNull();
  });

  it('matches only the text before the caret', () => {
    // The user clicked back into the middle. Completing against the end of the string would
    // replace the wrong span.
    expect(activeSlashQuery('/he lp', 3)).toEqual({ query: 'he', start: 0, end: 3 });
  });

  it('does not match a slash that is entirely after the caret', () => {
    expect(activeSlashQuery('hello /he', 5)).toBeNull();
  });
});

describe('filterCommands', () => {
  it('returns the whole catalog for an empty query', () => {
    expect(filterCommands('')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('ranks prefix matches before substring matches', () => {
    const names = filterCommands('st').map((command) => command.name);
    // `status` and `stop` start with "st"; `research` and `restart`-like names merely contain it.
    const prefixCount = names.filter((name) => name.startsWith('st')).length;
    expect(prefixCount).toBeGreaterThan(0);
    expect(names.slice(0, prefixCount).every((name) => name.startsWith('st'))).toBe(true);
  });

  it('matches against the description too', () => {
    // "reconcile" appears in exactly one description and in no command name, so this can only
    // pass through the description branch.
    expect(filterCommands('reconcile').map((command) => command.name)).toEqual(['moa']);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(filterCommands('zzzzzz')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(filterCommands('HELP').map((c) => c.name)).toEqual(filterCommands('help').map((c) => c.name));
  });
});

describe('the command catalog', () => {
  it('has no duplicate names', () => {
    // The server throws on a duplicate at registry build time, because one of the two would
    // become unreachable silently. The mirror has to hold the same property.
    const names = SLASH_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is sorted by name', () => {
    const names = SLASH_COMMANDS.map((command) => command.name);
    expect(names).toEqual([...names].sort());
  });

  it('gives every command a usage line that begins with its own name', () => {
    for (const command of SLASH_COMMANDS) {
      expect(command.usage.startsWith(`/${command.name}`)).toBe(true);
    }
  });

  it('marks the commands the server cannot yet run', () => {
    // `/research` is in the spec's table and the server registers it, but it answers "not
    // available in this build yet". Offering it unmarked would be a menu that lies.
    const research = SLASH_COMMANDS.find((command) => command.name === 'research');
    expect(research?.available).toBe(false);

    const agents = SLASH_COMMANDS.find((command) => command.name === 'agents');
    expect(agents?.available).toBe(true);
  });

  it('carries the owner-only marker through', () => {
    expect(SLASH_COMMANDS.find((c) => c.name === 'config')?.adminOnly).toBe(true);
    expect(SLASH_COMMANDS.find((c) => c.name === 'help')?.adminOnly).toBe(false);
  });
});

describe('completeCommand', () => {
  it('renders the command with its slash and no trailing space', () => {
    // The separator is `applyCompletion`'s job — a space here would produce two.
    const help = SLASH_COMMANDS.find((command) => command.name === 'help');
    expect(help).toBeDefined();
    expect(completeCommand(help!)).toBe('/help');
  });
});
