/**
 * The pure rules behind the newer forms.
 *
 * Three things are worth testing about a validator, and only the first is obvious: that it accepts
 * what it should, that it rejects what it should, and that its *empty* case is deliberate rather
 * than an accident. The empty case is the one that produces the worst bug — a validator that
 * refuses `''` makes a correctly-optional field impossible to submit, and it does so silently,
 * because the form simply never succeeds.
 *
 * `parentOf` is tested at the root boundary specifically: `''` and `'/'` differ by one character and
 * mean opposite things to the files API.
 */

import { describe, expect, it } from 'vitest';
import { cronShapeErrorFor, jsonErrorFor, parentOf } from './validation';

describe('jsonErrorFor', () => {
  const message = 'not valid JSON';

  it('accepts an empty field, because every caller treats the field as optional', () => {
    expect(jsonErrorFor('', message)).toBeNull();
    expect(jsonErrorFor('   \n\t ', message)).toBeNull();
  });

  it('accepts each JSON top-level shape', () => {
    expect(jsonErrorFor('{}', message)).toBeNull();
    expect(jsonErrorFor('{"a":1}', message)).toBeNull();
    expect(jsonErrorFor('[]', message)).toBeNull();
    expect(jsonErrorFor('"a string"', message)).toBeNull();
    expect(jsonErrorFor('42', message)).toBeNull();
    expect(jsonErrorFor('null', message)).toBeNull();
    expect(jsonErrorFor('true', message)).toBeNull();
  });

  it('accepts nested and whitespace-padded input', () => {
    expect(jsonErrorFor('  { "a": [1, { "b": null }] }  ', message)).toBeNull();
  });

  it('rejects malformed JSON', () => {
    expect(jsonErrorFor('{', message)).toBe(message);
    expect(jsonErrorFor('{"a":}', message)).toBe(message);
    expect(jsonErrorFor("{'a': 1}", message)).toBe(message);
    expect(jsonErrorFor('undefined', message)).toBe(message);
  });

  it('rejects trailing content after a complete value', () => {
    // `JSON.parse` refuses this, and it is the mistake a paste from a document makes.
    expect(jsonErrorFor('{"a":1} {"b":2}', message)).toBe(message);
  });

  it('returns the caller\u2019s own sentence verbatim', () => {
    expect(jsonErrorFor('{', 'skills say this')).toBe('skills say this');
    expect(jsonErrorFor('{', 'events say that')).toBe('events say that');
  });
});

describe('parentOf', () => {
  it('walks up one level', () => {
    expect(parentOf('a/b/c')).toBe('a/b');
    expect(parentOf('a/b')).toBe('a');
  });

  it('returns the root for a top-level entry', () => {
    expect(parentOf('a')).toBe('');
    expect(parentOf('README.md')).toBe('');
  });

  it('returns the root for the root itself, not an absolute path', () => {
    // `''` is what the files API uses for the root; `'/'` would be rejected as absolute.
    expect(parentOf('')).toBe('');
  });

  it('keeps the leading segment of a path whose first component is empty', () => {
    // `a//b` is malformed but must not throw or produce an absolute path.
    expect(parentOf('a//b')).toBe('a/');
  });

  it('does not treat a trailing slash as a parent', () => {
    expect(parentOf('a/b/')).toBe('a/b');
  });
});

describe('cronShapeErrorFor', () => {
  it('requires a value', () => {
    expect(cronShapeErrorFor('')).not.toBeNull();
    expect(cronShapeErrorFor('   ')).not.toBeNull();
  });

  it('accepts a six-field expression', () => {
    expect(cronShapeErrorFor('0 0 9 * * MON')).toBeNull();
    expect(cronShapeErrorFor('*/30 * * * * *')).toBeNull();
    expect(cronShapeErrorFor('0   0   9   *   *   MON')).toBeNull();
  });

  it('names the field count so a five-field paste is obviously wrong', () => {
    const error = cronShapeErrorFor('0 9 * * MON');
    expect(error).toContain('six');
    expect(error).toContain('5');
  });

  it('does not claim to validate ranges', () => {
    // The scheduler owns range validation; this is a shape check and says so.
    expect(cronShapeErrorFor('99 99 99 99 99 99')).toBeNull();
  });
});
