import { describe, expect, it } from 'vitest';
import {
  createProcessReaper,
  looksLikeOurChild,
  reapOrphan,
  type ProcessReaper,
} from '../src/services/mcp/orphans.js';

/**
 * [gap #22 / C1] The orphan reaper.
 *
 * The whole point of this module is the *refusals*. Killing a recorded pid is three lines;
 * the reason it needs its own file and its own tests is that between our death and our
 * restart the operating system may have handed that pid to an unrelated process, and a
 * blanket `SIGKILL` on a number read out of a database row is how a maintenance job kills
 * somebody else's service.
 */

interface FakeReaper extends ProcessReaper {
  killed: number[];
}

/** A reaper over a fixed table of live processes: pid → command line (`null` = opaque). */
function fakeReaper(live: Record<number, string | null>): FakeReaper {
  const killed: number[] = [];
  return {
    killed,
    async inspect(pid: number) {
      if (!(pid in live)) return { alive: false, commandLine: null };
      return { alive: true, commandLine: live[pid] ?? null };
    },
    async kill(pid: number) {
      killed.push(pid);
    },
  };
}

// ── matching ──────────────────────────────────────────────────────────────────

describe('attributing a command line', () => {
  it('matches when the recorded command appears in the observed line', () => {
    expect(looksLikeOurChild('/usr/bin/node /srv/mcp-fs.js', 'node')).toBe(true);
    expect(looksLikeOurChild('node /srv/mcp-fs.js', '/usr/local/bin/node')).toBe(true);
  });

  it('matches case-insensitively, because Windows reports a different case than the schema', () => {
    expect(looksLikeOurChild('C:\\NODE.EXE server.js', 'node')).toBe(true);
  });

  it('does not match an unrelated process', () => {
    expect(looksLikeOurChild('/usr/sbin/nginx -g daemon off;', 'node')).toBe(false);
    expect(looksLikeOurChild('/usr/bin/python3 manage.py runserver', 'node')).toBe(false);
  });

  it('does not match when the command is empty', () => {
    expect(looksLikeOurChild('anything', '')).toBe(false);
  });
});

// ── the policy ────────────────────────────────────────────────────────────────

describe('reaping one orphan', () => {
  it('kills a live process whose command line still matches', async () => {
    const reaper = fakeReaper({ 4242: 'node /srv/mcp-fs.js' });
    const verdict = await reapOrphan(reaper, { pid: 4242, command: 'node' });

    expect(verdict).toEqual({ action: 'killed', pid: 4242 });
    expect(reaper.killed).toEqual([4242]);
  });

  it('reports a process that is already gone without signalling it', async () => {
    const reaper = fakeReaper({});
    const verdict = await reapOrphan(reaper, { pid: 4242, command: 'node' });

    expect(verdict).toEqual({ action: 'gone', pid: 4242 });
    expect(reaper.killed).toEqual([]);
  });

  it('refuses when the platform cannot show us the command line', async () => {
    // This is the macOS and Windows case, and it is the important one: "alive but opaque"
    // is not evidence of ownership, so we leave it alone and let a human decide.
    const reaper = fakeReaper({ 4242: null });
    const verdict = await reapOrphan(reaper, { pid: 4242, command: 'node' });

    expect(verdict).toEqual({ action: 'skipped', pid: 4242, reason: 'unverifiable' });
    expect(reaper.killed).toEqual([]);
  });

  it('refuses when the pid now belongs to a different program', async () => {
    // The pid-recycling scenario: our child died, the number was reused.
    const reaper = fakeReaper({ 4242: '/usr/sbin/nginx -g daemon off;' });
    const verdict = await reapOrphan(reaper, { pid: 4242, command: 'node' });

    expect(verdict).toEqual({ action: 'skipped', pid: 4242, reason: 'not-our-process' });
    expect(reaper.killed).toEqual([]);
  });

  it('refuses when the row records no command to match against', async () => {
    const reaper = fakeReaper({ 4242: 'node server.js' });
    const verdict = await reapOrphan(reaper, { pid: 4242, command: null });

    expect(verdict).toEqual({ action: 'skipped', pid: 4242, reason: 'unverifiable' });
    expect(reaper.killed).toEqual([]);
  });

  it('never signals init, the process group, or ourselves', async () => {
    const reaper = fakeReaper({ 0: 'node', 1: 'node', [process.pid]: 'node' });

    for (const pid of [0, 1, process.pid]) {
      const verdict = await reapOrphan(reaper, { pid, command: 'node' });
      expect(verdict).toEqual({ action: 'skipped', pid, reason: 'protected' });
    }
    expect(reaper.killed).toEqual([]);
  });

  it('can be asked what it would do without doing it', async () => {
    const reaper = fakeReaper({ 4242: 'node server.js' });
    const verdict = await reapOrphan(reaper, { pid: 4242, command: 'node' }, { dryRun: true });

    expect(verdict.action).toBe('killed');
    expect(reaper.killed).toEqual([]);
  });
});

// ── the real reaper ───────────────────────────────────────────────────────────

describe('the platform reaper', () => {
  it('reports a pid that cannot exist as not alive', async () => {
    const reaper = createProcessReaper();
    // A pid far beyond any plausible live process. On Linux `process.kill` raises ESRCH;
    // on Windows it raises EINVAL or ESRCH depending on the range, and either way the
    // answer to "is this alive" is no.
    const inspection = await reaper.inspect(2_147_483_646);
    expect(inspection.alive).toBe(false);
  });

  it('sees the current process as alive', async () => {
    const reaper = createProcessReaper();
    const inspection = await reaper.inspect(process.pid);
    expect(inspection.alive).toBe(true);
  });

  it('only exposes a command line on Linux, where /proc exists', async () => {
    const reaper = createProcessReaper();
    const inspection = await reaper.inspect(process.pid);

    if (process.platform === 'linux') {
      expect(inspection.commandLine).toContain('node');
    } else {
      // The honest answer elsewhere. `reapOrphan` turns this into a refusal to kill.
      expect(inspection.commandLine).toBeNull();
    }
  });
});
