import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/services/chat/commands/types.js';

/**
 * Argument parsing for slash commands.
 *
 * Tested on its own because it is the one piece of the command path with genuine logic in it:
 * everything downstream is a service call, but `parseArgs` decides whether `/agent Scout
 * "watch the news"` creates an agent whose description is the whole sentence or the single
 * word "watch". A bug here is silent and produces a plausible-looking wrong answer.
 */

describe('parseArgs', () => {
  it('splits bare whitespace into positionals', () => {
    const args = parseArgs('Scout watch the news');
    expect(args.positional).toEqual(['Scout', 'watch', 'the', 'news']);
    expect(args.flags).toEqual({});
  });

  it('groups a double-quoted run into one token', () => {
    const args = parseArgs('Scout "watch the news hourly"');
    expect(args.positional).toEqual(['Scout', 'watch the news hourly']);
  });

  it('parses a flag with a value', () => {
    const args = parseArgs('summarise the front page --agent Scout');
    expect(args.positional).toEqual(['summarise', 'the', 'front', 'page']);
    expect(args.flags.agent).toBe('Scout');
  });

  it('parses several flags', () => {
    const args = parseArgs('do the thing --agent Scout --priority 2');
    expect(args.positional).toEqual(['do', 'the', 'thing']);
    expect(args.flags).toEqual({ agent: 'Scout', priority: '2' });
  });

  it('leaves a trailing flag with no value as an empty string', () => {
    // `/runs --status` must not swallow anything, and must not be mistaken for a positional.
    const args = parseArgs('--status');
    expect(args.flags.status).toBe('');
    expect(args.positional).toEqual([]);
  });

  it('does not let a flag consume the next flag as its value', () => {
    // The shell behaviour: `--a --b` means a is empty and b is set, not "a is set to --b".
    const args = parseArgs('--agent --status failed');
    expect(args.flags).toEqual({ agent: '', status: 'failed' });
  });

  it('tolerates an unterminated quote', () => {
    // This runs on text someone is mid-way through typing. Refusing to parse would make the
    // composer unusable while a user is still opening the quote.
    const args = parseArgs('Scout "watch the news');
    expect(args.positional).toEqual(['Scout', 'watch the news']);
  });

  it('keeps a quoted flag value as one token', () => {
    const args = parseArgs('task --agent "My Scout"');
    expect(args.flags.agent).toBe('My Scout');
  });

  it('preserves the raw text after the command name', () => {
    const args = parseArgs('Scout "watch the news" --agent x');
    expect(args.raw).toBe('Scout "watch the news" --agent x');
  });

  it('returns empty structures for empty input', () => {
    const args = parseArgs('');
    expect(args.positional).toEqual([]);
    expect(args.flags).toEqual({});
  });

  it('treats a bare -- as a positional rather than a flag', () => {
    const args = parseArgs('-- hello');
    expect(args.positional).toEqual(['--', 'hello']);
  });
});
