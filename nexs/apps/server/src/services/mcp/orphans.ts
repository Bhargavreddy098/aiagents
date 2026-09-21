import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';

/**
 * [gap #22 / C1] Reaping MCP child processes left behind by a hard kill.
 *
 * `MCPManager.shutdown()` handles the ordinary case: SIGTERM arrives, we close every
 * session, the SDK escalates stdin → SIGTERM → SIGKILL, and no child survives. This module
 * is for the case that bypasses it — `SIGKILL` on the parent, a container OOM kill, a
 * power loss — where a stdio child is reparented to init and keeps running, holding a port
 * or a lock that the next boot cannot take.
 *
 * The hard part is not killing. It is *not* killing the wrong thing: between our death and
 * our restart the operating system may hand our child's pid to an unrelated process, and a
 * blanket `SIGKILL` on a pid read from a database row is how a maintenance job kills
 * somebody else's service. So the rule here is:
 *
 *   > A pid is only signalled when we can prove it is still our child.
 *
 * Proof means the recorded command still appears in the process's own command line, which
 * is readable from `/proc/<pid>/cmdline` on Linux. Where that evidence is unavailable —
 * macOS and Windows both lack a portable equivalent — the process is left alone, the row is
 * marked `disconnected`, and the pid is logged so a human can decide. Refusing to act is
 * the correct failure mode for an operation that cannot be undone.
 */

export interface ProcessInspection {
  alive: boolean;
  /**
   * The process's command line, when the platform exposes it. `null` means "alive, but we
   * cannot see what it is" — which is treated as *unattributable*, not as a match.
   */
  commandLine: string | null;
}

export interface ProcessReaper {
  inspect(pid: number): Promise<ProcessInspection>;
  kill(pid: number, signal: NodeJS.Signals): Promise<void>;
}

export type OrphanVerdict =
  | { action: 'killed'; pid: number }
  | { action: 'gone'; pid: number }
  | { action: 'skipped'; pid: number; reason: 'unverifiable' | 'not-our-process' | 'protected' };

export interface ReapOrphanInput {
  pid: number;
  /** The `McpServer.command` we spawned. Absent for HTTP rows, which own no process. */
  command: string | null;
}

/**
 * Decide, and optionally perform, the fate of one recorded pid.
 *
 * Split from `reapOrphans` so the policy is testable without a database or a real process:
 * the interesting behaviour is entirely in these four branches.
 */
export async function reapOrphan(
  reaper: ProcessReaper,
  input: ReapOrphanInput,
  options: { dryRun?: boolean } = {},
): Promise<OrphanVerdict> {
  const { pid, command } = input;

  // A pid of 0 means "every process in the group" and 1 is init. Either would be
  // catastrophic, and neither can legitimately appear in the column.
  if (pid <= 1 || pid === process.pid) {
    return { action: 'skipped', pid, reason: 'protected' };
  }

  const inspection = await reaper.inspect(pid);
  if (!inspection.alive) return { action: 'gone', pid };

  if (command === null || command.length === 0) {
    return { action: 'skipped', pid, reason: 'unverifiable' };
  }

  if (inspection.commandLine === null) {
    // Alive, but the platform gives us no way to attribute it. Leave it.
    return { action: 'skipped', pid, reason: 'unverifiable' };
  }

  if (!looksLikeOurChild(inspection.commandLine, command)) {
    return { action: 'skipped', pid, reason: 'not-our-process' };
  }

  if (options.dryRun !== true) {
    await reaper.kill(pid, 'SIGKILL');
  }
  return { action: 'killed', pid };
}

/**
 * Does the command line we can read still match the command we spawned?
 *
 * Matching on the *basename* rather than the whole string, because an interpreter's command
 * line is the interpreter (`node`) followed by the script — a naive substring check against
 * `/usr/bin/node` fails, and a check that requires the full path fails when the kernel
 * reports a relative one. Basename-of-the-recorded-command appearing anywhere in the
 * observed line is the loosest test that still distinguishes our child from an unrelated
 * process.
 */
export function looksLikeOurChild(commandLine: string, command: string): boolean {
  const expected = basename(command).toLowerCase();
  if (expected.length === 0) return false;
  const observed = commandLine.toLowerCase();
  return observed.includes(expected);
}

/** The real reaper. Platform knowledge is confined to this object. */
export function createProcessReaper(): ProcessReaper {
  return {
    async inspect(pid: number): Promise<ProcessInspection> {
      if (!(await isAlive(pid))) return { alive: false, commandLine: null };

      if (process.platform === 'linux') {
        try {
          // NUL-separated; the trailing NUL makes `split` produce a final empty element.
          const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
          const commandLine = raw.split('\0').filter((part) => part.length > 0).join(' ');
          return { alive: true, commandLine: commandLine.length === 0 ? null : commandLine };
        } catch {
          // A zombie has no readable cmdline. It is already dead for our purposes.
          return { alive: true, commandLine: null };
        }
      }

      return { alive: true, commandLine: null };
    },

    async kill(pid: number, signal: NodeJS.Signals): Promise<void> {
      try {
        process.kill(pid, signal);
      } catch (cause) {
        // `ESRCH` means it exited between the inspection and the signal, which is the
        // outcome we wanted. Anything else is worth knowing about.
        if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
      }
    },
  };
}

/**
 * Signal 0 performs no delivery — it only runs the kernel's permission and existence
 * checks, which is exactly the "is this pid live" question.
 */
async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // `EPERM` means the process exists but belongs to another user; that still counts as
    // alive, and the kill attempt will fail loudly rather than silently.
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}
