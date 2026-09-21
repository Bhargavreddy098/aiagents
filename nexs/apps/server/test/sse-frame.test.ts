import { describe, expect, it } from 'vitest';
import {
  encodeSseFrame,
  inspectSsePayload,
  isSseEventName,
  SSE_EVENTS,
  SseFrameError,
  type SseFrameIssue,
} from '@nexs/shared';

/**
 * The last gate between a payload and a browser.
 *
 * `encodeSseFrame` is the only function that turns a frame into bytes, so this file is where the
 * catalog's claim — *"every payload is validated before it leaves the hub"* — is either true or
 * is not. Every emitter path in the system reaches a socket through it: the hub's fan-out, its
 * `closeTenant` goodbye, the controller's connect-time replay.
 *
 * ## What the validator is for, and what it is deliberately not for
 *
 * The payload *shapes* are already declared, once, in `SSE_EVENTS`, and TypeScript derives
 * `SsePayload<N>` from them. So a missing field or a mistyped one is a compile error at the emit
 * site — this file does not re-test that, and the validator does not re-derive it either. Writing
 * a second runtime description of each shape would be a copy that drifts from the types it
 * duplicates, which is the failure mode the catalog's single-declaration design exists to avoid.
 *
 * What is left is exactly what type erasure removes: a value the compiler is happy with and
 * `JSON.stringify` is not. Three of the cases below are *silent* in production — `undefined`,
 * a function and a symbol are dropped without a word, so the frame arrives missing a field that
 * both ends believe is there. Two are *fatal* — a `bigint` and a cycle make `JSON.stringify`
 * throw, and the throw lands inside the hub's fan-out where the bus's per-subscriber guard turns
 * it into a log line and the frame reaches nobody while the emitter believes it succeeded.
 *
 * ## Why a throw is the right outcome
 *
 * Not because it takes the system down — it does not. Every emitter already wraps its own
 * emission (the engine's `emit` catches and warns; the bus catches per subscriber), so a throw
 * converts "a frame nobody received, for a reason nobody recorded" into a log line naming the
 * event and the field. Dropping silently *here* would leave those wrappers with nothing to
 * report, which is the defect this validation exists to remove.
 */

/**
 * Hand a value to the encoder as though it came from the database or a JSON body.
 *
 * The validator exists to catch values the type system has already blessed, so a test of it must
 * be able to *produce* one. Casting is how a test tells the compiler "assume this is what the
 * declaration says" and then hands it something else — which is the whole situation being
 * defended against.
 */
function asPayload<T>(value: unknown): T {
  return value as T;
}

function issuesOf(name: string, payload: unknown): SseFrameIssue[] {
  return inspectSsePayload(name, payload);
}

// ── the format ────────────────────────────────────────────────────────────────

describe('the frame format', () => {
  it('encodes a declared frame byte for byte', () => {
    expect(encodeSseFrame('run.started', { runId: 'run_1' }, 'evt_1')).toBe(
      'id: evt_1\n' +
        'event: run.started\n' +
        'data: {"name":"run.started","payload":{"runId":"run_1"}}\n\n',
    );
  });

  it('omits the id line when no id is given', () => {
    expect(encodeSseFrame('run.started', { runId: 'run_1' })).toBe(
      'event: run.started\n' + 'data: {"name":"run.started","payload":{"runId":"run_1"}}\n\n',
    );
  });

  it('produces a frame a client can actually read back', () => {
    // Byte-exactness is not the property that matters to a browser — this is. An `EventSource`
    // splits on blank lines and reads the `data:` line, so the assertion below is the client's
    // own parse, not a restatement of the encoder.
    const frame = encodeSseFrame('approval.created', {
      approvalId: 'apr_1',
      title: 'Send the email',
      risk: { level: 'medium', reasons: ['writes outside the sandbox'] },
    });

    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
    expect(dataLine).toBeDefined();

    const parsed = JSON.parse(dataLine!.slice('data: '.length)) as {
      name: string;
      payload: { approvalId: string; risk: { reasons: string[] } };
    };

    expect(parsed.name).toBe('approval.created');
    expect(parsed.payload.approvalId).toBe('apr_1');
    expect(parsed.payload.risk.reasons).toEqual(['writes outside the sandbox']);
  });
});

// ── the catalog is the contract ───────────────────────────────────────────────

describe('an undeclared event name', () => {
  it('is refused, with the name it was given', () => {
    const issues = issuesOf('run.typoed', { runId: 'r' });

    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe('name');
    expect(issues[0]!.message).toContain('run.typoed');
  });

  it('does not accept a name inherited from Object.prototype', () => {
    // The case a plain `name in SSE_EVENTS` gets wrong: `'constructor' in {}` is true, and
    // `SSE_EVENTS['toString']` is a function. Either would be accepted as a declared event and
    // emitted to a client that is listening for nothing — a frame that costs a round trip and
    // delivers no information, with no error anywhere.
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(isSseEventName(inherited), inherited).toBe(false);
      expect(issuesOf(inherited, {}), inherited).toHaveLength(1);
    }
  });

  it('accepts every name the catalog declares', () => {
    for (const name of Object.keys(SSE_EVENTS)) {
      expect(isSseEventName(name), name).toBe(true);
    }
  });

  it('reports the name before anything about the payload', () => {
    // A wrong name makes the payload's shape unknowable, so a second issue about it would be
    // noise pointing at the wrong thing.
    expect(issuesOf('not.an.event', { runId: undefined })).toHaveLength(1);
  });
});

// ── the payload must be an object ─────────────────────────────────────────────

describe('the payload itself', () => {
  it('must be a plain object, because every declared payload is one', () => {
    for (const bad of [null, [], 'text', 42, true, undefined]) {
      const issues = issuesOf('run.started', bad);
      expect(issues, String(bad)).toHaveLength(1);
      expect(issues[0]!.path).toBe('payload');
    }
  });

  it('accepts a null-prototype record, which is still plain JSON', () => {
    // `Object.create(null)` is a legitimate way to build a record — a lookup table keyed by user
    // input, say — and JSON.stringify cannot tell it from an object literal.
    const payload = Object.create(null) as Record<string, unknown>;
    payload['runId'] = 'run_1';

    expect(issuesOf('run.started', payload)).toEqual([]);
  });

  it('accepts an empty object, and says so is deliberate', () => {
    // Pinning the *boundary* of the validator, not a defect. `run.started` declares `runId`, and
    // `{}` satisfies this check because the missing field is the compiler's business: the emit
    // site is typed `SsePayload<'run.started'>`, and no runtime value reaches here without
    // having passed through that signature. Re-deriving the shape would duplicate the catalog.
    expect(issuesOf('run.started', {})).toEqual([]);
  });
});

// ── values JSON cannot carry ──────────────────────────────────────────────────

describe('values that would not survive the wire', () => {
  it('refuses undefined, which JSON.stringify drops without a word', () => {
    const issues = issuesOf('run.started', { runId: undefined });

    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe('runId');
    expect(issues[0]!.message).toContain('undefined');
  });

  it('names the exact path of a nested defect', () => {
    // The path is the whole value of the report: a plan is an array of steps with a config each,
    // and "somewhere in this plan a value is undefined" is not actionable.
    const issues = issuesOf('run.plan_ready', {
      runId: 'run_1',
      plan: [
        { id: 's1', description: 'first', stepType: 'transform', config: { operation: 'template' } },
        {
          id: 's2',
          description: 'second',
          stepType: 'tool',
          config: { retries: undefined, toolName: 'http_request' },
        },
      ],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe('plan[1].config.retries');
  });

  it('refuses a bigint, which JSON.stringify cannot serialize at all', () => {
    const issues = issuesOf('step.completed', { runId: 'r', stepId: 's', durationMs: 10n });

    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe('durationMs');
    expect(issues[0]!.message).toContain('bigint');
  });

  it('refuses a function and a symbol, which are dropped like undefined', () => {
    for (const value of [(): void => undefined, Symbol('nope')]) {
      const issues = issuesOf('run.completed', { runId: 'r', output: value });
      expect(issues, String(value)).toHaveLength(1);
      expect(issues[0]!.path).toBe('output');
    }
  });

  it('refuses NaN and Infinity, which arrive as null', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const issues = issuesOf('step.completed', { runId: 'r', stepId: 's', durationMs: value });
      expect(issues, String(value)).toHaveLength(1);
      expect(issues[0]!.message).toContain('null');
    }
  });

  it('refuses a circular reference, and points at the link that closes the loop', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node['self'] = node;

    const issues = issuesOf('run.completed', { runId: 'r', output: node });

    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe('output.self');
    expect(issues[0]!.message).toContain('circular');
  });

  it('allows a sub-object two keys both point at', () => {
    // The distinction the cycle detector has to make, and the reason it tracks *ancestors*
    // rather than every value it has seen. A shared reference is ordinary JSON — an object
    // reachable by two paths serializes twice — so a naive visited-set would refuse a payload
    // that is perfectly valid, and would do it only for the inputs that happen to share a node.
    const shared = { provider: 'openai', model: 'gpt-4o' };
    const issues = issuesOf('run.completed', {
      runId: 'r',
      output: { planned: shared, executed: shared },
    });

    expect(issues).toEqual([]);
  });

  it('refuses a Date, a Map and a Buffer, which JSON does not round-trip as declared', () => {
    // Coercion here is silent, which is why these are refused rather than converted. A `Date`
    // becomes an ISO string that a `number` field downstream will accept; a `Buffer` becomes
    // `{"0":137,"1":80,…}`, which is not the shape anything declared.
    const cases: Array<[string, unknown]> = [
      ['Date', new Date('2026-09-20T12:00:00.000Z')],
      ['Map', new Map([['k', 'v']])],
      ['Set', new Set(['v'])],
      ['Buffer', Buffer.from('secret')],
    ];

    for (const [label, value] of cases) {
      const issues = issuesOf('run.completed', { runId: 'r', output: value });
      expect(issues, label).toHaveLength(1);
      expect(issues[0]!.message, label).toContain(label);
    }
  });

  it('refuses a hole in a sparse array, which JSON turns into null', () => {
    // `[1, , 3]` serializes to `[1,null,3]` — a value the emitter never wrote, appearing in a
    // frame as though it had. Building the hole by assignment rather than with a literal keeps
    // this test honest about what it is constructing (and clear of `no-sparse-arrays`).
    const sparse: unknown[] = [];
    sparse[1] = 'b';

    const issues = issuesOf('run.completed', { runId: 'r', output: sparse });

    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe('output[0]');
  });

  it('refuses a structure nested deeper than the limit', () => {
    let deep: unknown = 'leaf';
    for (let level = 0; level < 70; level += 1) deep = { next: deep };

    const issues = issuesOf('run.completed', { runId: 'r', output: deep });

    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('deeper than');
  });

  it('reports a bounded number of defects rather than one per key', () => {
    // A payload is usually malformed in one way repeated many times. An unbounded report would
    // put a thousand-line string into a log field and bury the line that says which event it was.
    const payload: Record<string, unknown> = { runId: 'r' };
    for (let index = 0; index < 40; index += 1) payload[`k${index}`] = undefined;

    const issues = issuesOf('run.completed', payload);

    expect(issues).toHaveLength(10);
    expect(issues[0]!.path).toBe('k0');
  });
});

// ── the throw ─────────────────────────────────────────────────────────────────

describe('encoding a frame that would not survive', () => {
  it('throws SseFrameError, carrying the event and the issues', () => {
    const caught = ((): unknown => {
      try {
        encodeSseFrame('run.started', asPayload({ runId: undefined }));
        return null;
      } catch (err) {
        return err;
      }
    })();

    expect(caught).toBeInstanceOf(SseFrameError);

    const error = caught as SseFrameError;
    expect(error.eventName).toBe('run.started');
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]!.path).toBe('runId');
    // The message is what ends up in a log line next to the event name, so it has to name both.
    expect(error.message).toContain('run.started');
    expect(error.message).toContain('runId');
    expect(error.name).toBe('SseFrameError');
  });

  it('throws before producing any bytes, so a bad frame cannot be half-written', () => {
    // The encode happens once, before the hub fans out, so a throw here is a throw with no
    // client yet written to — which is what makes it safe for the hub not to catch it.
    let produced: string | null = null;
    try {
      produced = encodeSseFrame('run.started', asPayload({ runId: undefined }));
    } catch {
      /* expected */
    }
    expect(produced).toBeNull();
  });

  it('is not an ApiError, because it never crosses HTTP', () => {
    // A defect in an emitter is not a condition of a request, and giving it an HTTP status
    // would invite somebody to handle it as one.
    const caught = ((): unknown => {
      try {
        encodeSseFrame('run.started', asPayload({ runId: undefined }));
        return null;
      } catch (err) {
        return err;
      }
    })();

    expect(caught).not.toHaveProperty('http');
  });
});
