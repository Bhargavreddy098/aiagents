/**
 * The seed, asserted against the spec.
 *
 * This file exists because a seed is unusually easy to get wrong in a way that looks right. Every
 * mistake it can make — a run marked `completed` with no `completedAt`, a provider whose
 * `modelCount` disagrees with its models, a goal that claims completion with no verification
 * behind it, a research finding citing a source that was never collected — renders as a plausible
 * screen. The numbers come from the database, the UI is faithful, and the fixture is lying.
 *
 * So the assertions here are of three kinds, and the third is the one that matters:
 *
 *  1. **Counts** — the numbers the spec fixes.
 *  2. **Invariants** — the relationships the schema encodes but does not enforce: a completion
 *     cites a passing verification, a receipt exists for every effect, a step carries a timestamp
 *     in every state that implies one.
 *  3. **Traceability** — that `runSeed`'s returned summary, which is what the CLI prints and what
 *     a developer reads, agrees with the rows actually written. A summary that is computed rather
 *     than counted would be the same class of lie the project forbids everywhere else.
 *
 * The seed is written once for the whole file and every test reads. `runSeed` is deterministic
 * given `now`, so a shared fixture is safe; the one test that needs a second run builds its own
 * database.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import {
  validateWorkflowSteps,
  type WorkflowStepRow,
} from '../src/repositories/workflow.repo.js';
import { toJson } from '../src/repositories/json.js';
import { verifyPassword } from '../src/services/auth/password.js';
import { SeedAlreadyAppliedError, runSeed, type SeedCounts, type SeedSummary } from '../src/seed/run.js';
import { SEED_MARKER, SEED_USER } from '../src/seed/fixtures.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

const config = loadConfig();
const logger = createLogger(config);

/** A fixed clock, so every offset the fixture declares can be asserted exactly. */
const NOW = new Date('2026-09-20T12:00:00.000Z');
const minutesBefore = (minutes: number): number => NOW.getTime() - minutes * 60_000;

let fake: FakeDb;
let summary: SeedSummary;

beforeAll(async () => {
  fake = createFakeDb();
  summary = await runSeed({ config, logger, db: fake.client, now: NOW });
});

/** Rows of a table, keyed by the Prisma client key. */
function rows(table: string): Array<Record<string, unknown>> {
  const found = fake.tables[table];
  if (found === undefined) throw new Error(`no such table in the fake: ${table}`);
  return found as Array<Record<string, unknown>>;
}

/** Rows of a table matching every field of `match`. */
function where(table: string, match: Record<string, unknown>): Array<Record<string, unknown>> {
  return rows(table).filter((row) => Object.entries(match).every(([key, value]) => row[key] === value));
}

function one(table: string, match: Record<string, unknown>): Record<string, unknown> {
  const found = where(table, match);
  if (found.length !== 1) throw new Error(`expected exactly 1 ${table} row, found ${found.length}`);
  return found[0]!;
}

/** Every table the seed writes that owns a `tenantId` column. */
const TENANT_OWNED_TABLES = [
  'user',
  'credential',
  'modelProvider',
  'model',
  'tool',
  'mcpServer',
  'connector',
  'agent',
  'goal',
  'task',
  'workflow',
  'run',
  'toolCall',
  'executionReceipt',
  'verification',
  'action',
  'approval',
  'schedule',
  'memory',
  'researchProject',
  'notification',
] as const;

/**
 * The tables the schema deliberately leaves without a `tenantId`.
 *
 * Listed rather than derived, because the point of the assertion is that the *schema's* rule holds
 * in the fixture: a leaf row proves ownership by being read through its parent, and a `tenantId`
 * appearing on one of these would mean the seed had invented a column.
 */
const LEAF_TABLES = [
  'connectorAccount',
  'agentVersion',
  'workflowVersion',
  'step',
  'researchRun',
  'researchSource',
  'researchFinding',
] as const;

/** `SeedCounts` key → the Prisma client key of the table it counts. */
const COUNT_TABLE: Record<keyof SeedCounts, string> = {
  tenants: 'tenant',
  users: 'user',
  credentials: 'credential',
  providers: 'modelProvider',
  models: 'model',
  tools: 'tool',
  mcpServers: 'mcpServer',
  connectors: 'connector',
  connectorAccounts: 'connectorAccount',
  agents: 'agent',
  agentVersions: 'agentVersion',
  goals: 'goal',
  tasks: 'task',
  workflows: 'workflow',
  workflowVersions: 'workflowVersion',
  runs: 'run',
  steps: 'step',
  toolCalls: 'toolCall',
  receipts: 'executionReceipt',
  verifications: 'verification',
  actions: 'action',
  approvals: 'approval',
  schedules: 'schedule',
  memories: 'memory',
  researchProjects: 'researchProject',
  researchRuns: 'researchRun',
  researchSources: 'researchSource',
  researchFindings: 'researchFinding',
  notifications: 'notification',
};

describe('seed', () => {
  describe('the account it creates', () => {
    it('creates the dev user with a password hash the login route accepts', async () => {
      const user = one('user', { email: SEED_USER.email });

      // The strongest available proof that the seeded account can sign in: the same verifier the
      // login route calls, against the same hash. A seed whose user cannot log in has not been
      // tested, and this is the test.
      await expect(verifyPassword(String(user['passwordHash']), SEED_USER.password)).resolves.toBe(true);
      await expect(verifyPassword(String(user['passwordHash']), 'not-the-password')).resolves.toBe(false);
    });

    it('never stores the password in the clear', () => {
      const user = one('user', { email: SEED_USER.email });
      expect(String(user['passwordHash'])).not.toContain(SEED_USER.password);
    });

    it('makes the dev user the workspace owner, so exec approvals can be answered', () => {
      // §4.4: only the owner may grant an exec approval, and the fixture seeds one. An unowned
      // workspace would leave that approval permanently unanswerable.
      const tenant = one('tenant', { id: summary.tenantId });
      expect(tenant['ownerUserId']).toBe(summary.userId);
    });
  });

  describe('the counts the spec fixes', () => {
    it('writes exactly one of each singleton', () => {
      expect(summary.counts.tenants).toBe(1);
      expect(summary.counts.users).toBe(1);
      expect(summary.counts.connectors).toBe(1);
      expect(summary.counts.mcpServers).toBe(1);
      expect(summary.counts.researchProjects).toBe(1);
    });

    it('writes three agents, named as the spec names them', () => {
      expect(rows('agent').map((row) => row['name']).sort()).toEqual([
        'Browser Scout',
        'Operator',
        'Researcher',
      ]);
    });

    it('writes two providers with their models', () => {
      expect(rows('modelProvider').map((row) => row['slug']).sort()).toEqual(['ollama', 'openai']);
      expect(summary.counts.models).toBe(5);
    });

    it('writes two goals, one active and one completed', () => {
      expect(summary.counts.goals).toBe(2);
      expect(where('goal', { status: 'active' })).toHaveLength(1);
      expect(where('goal', { status: 'completed' })).toHaveLength(1);
    });

    it('writes five tasks spanning several states', () => {
      expect(summary.counts.tasks).toBe(5);
      expect(new Set(rows('task').map((row) => row['status'])).size).toBeGreaterThanOrEqual(4);
    });

    it('writes two workflows, one active and versioned', () => {
      expect(summary.counts.workflows).toBe(2);
      expect(where('workflow', { status: 'active' })).toHaveLength(1);
      // A workflow that has never been edited has one version; the spec asks for a *versioned*
      // one, so at least one workflow must carry more than one.
      expect(summary.counts.workflowVersions).toBeGreaterThan(summary.counts.workflows);
    });

    it('writes eight runs spanning several states', () => {
      expect(summary.counts.runs).toBe(8);
      expect(new Set(rows('run').map((row) => row['status'])).size).toBeGreaterThanOrEqual(6);
    });

    it('writes two approvals, both pending', () => {
      expect(summary.counts.approvals).toBe(2);
      expect(where('approval', { status: 'pending' })).toHaveLength(2);
    });

    it('writes three schedules and one connector', () => {
      expect(summary.counts.schedules).toBe(3);
      expect(summary.counts.connectors).toBe(1);
      expect(summary.counts.connectorAccounts).toBe(1);
    });

    it('writes a research project with sources and findings', () => {
      expect(summary.counts.researchSources).toBeGreaterThanOrEqual(3);
      expect(summary.counts.researchFindings).toBeGreaterThanOrEqual(1);
    });

    it('writes sample memory and notifications', () => {
      expect(summary.counts.memories).toBeGreaterThan(0);
      expect(summary.counts.notifications).toBeGreaterThan(0);
    });
  });

  describe('the summary traces to rows', () => {
    it('reports a count that matches the rows actually written', () => {
      // The honesty rule applied to the seed itself: the number the CLI prints is counted, not
      // asserted. A summary computed from the fixture would be a second source of truth, and this
      // is what stops it drifting from the first.
      for (const [name, table] of Object.entries(COUNT_TABLE)) {
        expect(
          { count: summary.counts[name as keyof SeedCounts], table },
          `${name} disagrees with ${table}`,
        ).toEqual({ count: rows(table).length, table });
      }
    });
  });

  describe('the invariants the schema encodes', () => {
    it('keeps modelCount equal to the models actually written', () => {
      // A number on screen that traces to a row — here, to *the* rows it claims to count.
      for (const provider of rows('modelProvider')) {
        const written = where('model', { providerId: provider['id'] }).length;
        expect(provider['modelCount']).toBe(written);
      }
    });

    it('completes a goal only through a verification that passed', () => {
      const goal = one('goal', { status: 'completed' });
      const verificationId = goal['completedVerificationId'];
      expect(verificationId).toBeTruthy();

      const verification = one('verification', { id: verificationId });
      expect(verification['passed']).toBe(true);
      expect(verification['status']).toBe('passed');
      expect(verification['scope']).toBe('goal_criteria');
      // The verification must be about *this* goal, not a borrowed one.
      expect(verification['goalId']).toBe(goal['id']);
    });

    it('leaves the active goal without a completion', () => {
      const goal = one('goal', { status: 'active' });
      expect(goal['completedVerificationId']).toBeNull();
      expect(goal['completedAt']).toBeNull();
    });

    it('dates every completed run and gives it a duration', () => {
      const completed = where('run', { status: 'completed' });
      expect(completed.length).toBeGreaterThan(0);
      for (const run of completed) {
        expect(run['completedAt']).toBeInstanceOf(Date);
        expect(run['startedAt']).toBeInstanceOf(Date);
        expect(typeof run['durationMs']).toBe('number');
        // A completion before its own start would render as a negative duration.
        expect((run['completedAt'] as Date).getTime()).toBeGreaterThanOrEqual(
          (run['startedAt'] as Date).getTime(),
        );
      }
    });

    it('gives every failed run an error to show', () => {
      for (const run of where('run', { status: 'failed' })) {
        expect(typeof run['error']).toBe('string');
        expect(String(run['error']).length).toBeGreaterThan(0);
      }
    });

    it('gives every running run a heartbeat, so the reaper does not reap it', () => {
      // `RunRepository.listStale` reaps active runs whose heartbeat is old. A seeded `running` run
      // with no heartbeat would be killed by the first recovery sweep — a fixture that breaks
      // itself the moment the server boots.
      for (const run of where('run', { status: 'running' })) {
        expect(run['lastHeartbeatAt']).toBeInstanceOf(Date);
        expect((run['lastHeartbeatAt'] as Date).getTime()).toBeGreaterThan(minutesBefore(10));
      }
    });

    it('leaves a queued run with nothing but its creation time', () => {
      for (const run of where('run', { status: 'queued' })) {
        expect(run['startedAt']).toBeNull();
        expect(run['completedAt']).toBeNull();
      }
    });

    it('dates every step that is finished and none that is not', () => {
      for (const step of rows('step')) {
        const status = step['status'];
        if (status === 'completed' || status === 'failed') {
          expect(step['completedAt'], `${String(step['name'])} is ${String(status)}`).toBeInstanceOf(Date);
        }
        if (status === 'pending') {
          expect(step['startedAt']).toBeNull();
          expect(step['completedAt']).toBeNull();
        }
      }
    });

    it('writes a receipt for every executed call that had a side effect', () => {
      const sideEffecting = rows('toolCall').filter(
        (call) => call['sideEffect'] === true && call['status'] === 'executed',
      );
      expect(sideEffecting.length).toBeGreaterThan(0);

      for (const call of sideEffecting) {
        const receipts = where('executionReceipt', { toolCallId: call['id'] });
        expect(receipts, `no receipt for tool call ${String(call['id'])}`).toHaveLength(1);
      }
    });

    it('cites the exact attempt on every receipt', () => {
      // The receipt's idempotency key is the step's key plus a suffix. If they ever disagree the
      // unique index is still correct and the receipt is merely less useful — so this asserts the
      // redundancy holds rather than that the index does.
      for (const receipt of rows('executionReceipt')) {
        const call = one('toolCall', { id: receipt['toolCallId'] });
        const step = one('step', { id: call['stepId'] });
        expect(String(receipt['idempotencyKey'])).toContain(String(step['idempotencyKey']));
      }
    });

    it('writes the steps of each run in order, with unique sequences', () => {
      for (const run of rows('run')) {
        const steps = where('step', { runId: run['id'] });
        const seqs = steps.map((step) => Number(step['seq']));
        expect(new Set(seqs).size).toBe(seqs.length);
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      }
    });

    it('gives every tool call a tool row of the same tenant', () => {
      for (const call of rows('toolCall')) {
        const tool = one('tool', { id: call['toolId'] });
        expect(tool['tenantId']).toBe(summary.tenantId);
      }
    });

    it('seeds both approvals pending, in the future, each with an action', () => {
      for (const approval of where('approval', { status: 'pending' })) {
        // An `expiresAt` in the past would be swept to `expired` by the next tick and the decision
        // inbox would be empty — the fixture would look broken on first boot.
        expect((approval['expiresAt'] as Date).getTime()).toBeGreaterThan(NOW.getTime());
        expect(approval['actionId']).toBeTruthy();
        const action = one('action', { id: approval['actionId'] });
        expect(action['tenantId']).toBe(summary.tenantId);
      }
    });

    it('seeds one approval of each kind', () => {
      // A tool gate answers approve/reject; an exec gate answers allow-once/allow-always/deny.
      // Seeding only the first would leave the §4.4 path with nothing to render.
      expect(new Set(where('approval', { status: 'pending' }).map((row) => row['kind']))).toEqual(
        new Set(['tool', 'exec']),
      );
    });

    it('schedules the next fire in the future', () => {
      for (const schedule of rows('schedule')) {
        expect(schedule['enabled']).toBe(true);
        expect((schedule['nextFireAt'] as Date).getTime()).toBeGreaterThan(NOW.getTime());
      }
    });

    it('uses a non-UTC timezone somewhere, so the column is exercised', () => {
      expect(rows('schedule').some((row) => row['timezone'] !== 'UTC')).toBe(true);
    });

    it('points every schedule at a target of the kind it declares', () => {
      for (const schedule of rows('schedule')) {
        const table = schedule['targetKind'] === 'workflow' ? 'workflow' : 'task';
        expect(() => one(table, { id: schedule['targetId'] })).not.toThrow();
      }
    });

    it('sets the task back-reference for every task a schedule fires', () => {
      for (const schedule of where('schedule', { targetKind: 'task' })) {
        const task = one('task', { id: schedule['targetId'] });
        expect(task['scheduleId']).toBe(schedule['id']);
      }
    });

    it('agrees with the schedule about when a scheduled task is due', () => {
      // `Task.scheduledAt` and `Schedule.nextFireAt` describe the same instant in two columns, so
      // nothing enforces that they agree — and a fixture where they disagree shows a task due at
      // one time beside a schedule that fires at another.
      let compared = 0;
      for (const schedule of where('schedule', { targetKind: 'task' })) {
        const task = one('task', { id: schedule['targetId'] });
        if (task['scheduledAt'] === null) continue;
        expect((task['scheduledAt'] as Date).getTime()).toBe((schedule['nextFireAt'] as Date).getTime());
        compared += 1;
      }
      expect(compared).toBeGreaterThan(0);
    });

    it('leaves no unresolved placeholder in a notification route', () => {
      for (const notification of rows('notification')) {
        const route = String(notification['linkRoute']);
        expect(route).not.toContain('{');
        expect(route).not.toContain('}');
        expect(route.startsWith('/')).toBe(true);
      }
    });

    it('marks some notifications read and some not', () => {
      const read = rows('notification').filter((row) => row['readAt'] !== null);
      expect(read.length).toBeGreaterThan(0);
      expect(read.length).toBeLessThan(rows('notification').length);
    });

    it('stores credentials as vault ciphertext, never the placeholder', () => {
      const credentials = rows('credential');
      expect(credentials.length).toBeGreaterThan(0);
      for (const credential of credentials) {
        const encrypted = String(credential['encrypted']);
        // The vault's envelope: version prefix, then base64.
        expect(encrypted.startsWith('v1:')).toBe(true);
        expect(encrypted).not.toContain('placeholder');
        // Only the masked prefix is exposed for the UI.
        expect(String(credential['keyPrefix'])).toContain('…');
      }
    });

    it('leaves the connector disconnected, since nothing verified its token', () => {
      const connector = one('connector', { type: 'github' });
      expect(connector['status']).toBe('disconnected');
      // The adapter's declared actions are still recorded: what it *can* do is knowable without a
      // working credential, and that is the distinction the row keeps.
      expect(Array.isArray(connector['capabilityDiscovery'])).toBe(true);
      expect((connector['capabilityDiscovery'] as unknown[]).length).toBeGreaterThan(0);
    });

    it('leaves the MCP server disconnected with no cached tools', () => {
      const server = one('mcpServer', { name: 'Filesystem' });
      expect(server['status']).toBe('disconnected');
      expect(server['pid']).toBeNull();
      expect(where('mCPTool', { serverId: server['id'] })).toHaveLength(0);
    });
  });

  describe('the research acceptance criterion', () => {
    it('collects at least three sources on the completed run', () => {
      const completed = one('researchRun', { status: 'completed' });
      expect(where('researchSource', { runId: completed['id'] }).length).toBeGreaterThanOrEqual(3);
    });

    it('verifies at least one finding', () => {
      const completed = one('researchRun', { status: 'completed' });
      const findings = where('researchFinding', { runId: completed['id'] });
      expect(findings.some((finding) => finding['verified'] === true)).toBe(true);
    });

    it('cites only sources its own run collected', () => {
      // The provenance link is the point of the table. A finding citing a source from another run
      // would render as a citation that cannot be followed.
      for (const finding of rows('researchFinding')) {
        const own = new Set(where('researchSource', { runId: finding['runId'] }).map((row) => row['id']));
        const cited = finding['sourceIds'] as string[];
        expect(cited.length).toBeGreaterThan(0);
        for (const sourceId of cited) expect(own.has(sourceId)).toBe(true);
      }
    });

    it('links the running research run to a real engine run', () => {
      const running = one('researchRun', { status: 'running' });
      expect(running['runId']).toBeTruthy();
      const engineRun = one('run', { id: running['runId'] });
      expect(engineRun['kind']).toBe('research');
      expect(engineRun['status']).toBe('queued');
    });
  });

  describe('the allowlists resolve', () => {
    it('gives every agent tools that exist', () => {
      for (const agent of rows('agent')) {
        const toolIds = agent['toolIds'] as string[];
        expect(toolIds.length).toBeGreaterThan(0);
        for (const toolId of toolIds) expect(() => one('tool', { id: toolId })).not.toThrow();
      }
    });

    it('gives every agent a model that exists', () => {
      for (const agent of rows('agent')) {
        expect(agent['modelId']).toBeTruthy();
        expect(() => one('model', { id: agent['modelId'] })).not.toThrow();
      }
    });

    it('resolves every connector account an agent is granted', () => {
      const granted = rows('agent').flatMap((agent) => agent['connectorAccountIds'] as string[]);
      expect(granted.length).toBeGreaterThan(0);
      for (const accountId of granted) expect(() => one('connectorAccount', { id: accountId })).not.toThrow();
    });

    it('resolves every MCP server an agent is granted', () => {
      const granted = rows('agent').flatMap((agent) => agent['mcpServerIds'] as string[]);
      expect(granted.length).toBeGreaterThan(0);
      for (const serverId of granted) expect(() => one('mcpServer', { id: serverId })).not.toThrow();
    });

    it('provisions the built-in tools from the registry rather than a list', () => {
      const builtins = where('tool', { source: 'builtin' });
      // The always-registered handlers: http_request, calculator, date_time, file_read,
      // file_write, notify, memory_store, memory_search. `web_search` is absent because no search
      // provider is configured in this environment — and its absence is the assertion.
      expect(builtins.length).toBe(8);
      expect(builtins.map((row) => row['name']).sort()).toEqual([
        'calculator',
        'date_time',
        'file_read',
        'file_write',
        'http_request',
        'memory_search',
        'memory_store',
        'notify',
      ]);
    });

    it('leaves the built-in rows without a capability set, so the registry answers', () => {
      for (const tool of where('tool', { source: 'builtin' })) {
        expect(tool['capabilities']).toEqual([]);
      }
    });
  });

  describe('the runs pin their configuration', () => {
    it('gives every run an agent and an agent version', () => {
      for (const run of rows('run')) {
        expect(run['agentId']).toBeTruthy();
        // Gap #15: a run pins the exact config version at start rather than re-reading the agent.
        expect(run['agentVersionId']).toBeTruthy();
        const version = one('agentVersion', { id: run['agentVersionId'] });
        expect(version['agentId']).toBe(run['agentId']);
      }
    });

    it('points the pinned version at the agent it belongs to, at version 1', () => {
      for (const version of rows('agentVersion')) {
        expect(version['version']).toBe(1);
        expect(() => one('agent', { id: version['agentId'] })).not.toThrow();
      }
    });

    it('resolves every run goal and task reference', () => {
      for (const run of rows('run')) {
        if (run['goalId'] !== null) expect(() => one('goal', { id: run['goalId'] })).not.toThrow();
        if (run['taskId'] !== null) expect(() => one('task', { id: run['taskId'] })).not.toThrow();
        if (run['workflowId'] !== null) {
          expect(() => one('workflow', { id: run['workflowId'] })).not.toThrow();
        }
      }
    });

    it('gives every run a correlation id that names the fixture row', () => {
      // The column that traces logs to a row. A recognisable value is what lets a developer match
      // a log line back to the fixture entry that produced it.
      for (const run of rows('run')) {
        expect(String(run['correlationId'])).toMatch(/^seed-/);
      }
    });

    it('leaves a checkpoint on every paused run', () => {
      const paused = where('run', { status: 'paused' });
      expect(paused.length).toBeGreaterThan(0);
      for (const run of paused) expect(run['checkpoint']).not.toBeNull();
    });
  });

  describe('the workflows it writes', () => {
    it('validates every version against the authoring rules', () => {
      // `validateWorkflowSteps` is the same check the workflow service applies to a submitted step
      // list. Running it over the seeded versions proves the fixture would have been accepted
      // through the API rather than only through a direct write — which is the difference between
      // a fixture and a pile of rows.
      let checked = 0;
      for (const version of rows('workflowVersion')) {
        const steps = where('workflowStep', { versionId: version['id'] }).map((step) => {
          const config = (step['config'] ?? {}) as Record<string, unknown>;
          const row: WorkflowStepRow = {
            name: String(step['name']),
            stepType: step['stepType'] as WorkflowStepRow['stepType'],
            config: toJson(config),
            ...(typeof config['toolId'] === 'string' ? { toolId: config['toolId'] } : {}),
            ...(Array.isArray(step['dependsOn']) ? { dependsOn: step['dependsOn'] as string[] } : {}),
          };
          return row;
        });

        expect(validateWorkflowSteps(steps), `version ${String(version['id'])}`).toEqual([]);
        checked += 1;
      }

      // Both workflows, with the revised one counted twice: three versions in total.
      expect(checked).toBe(3);
    });

    it('points every workflow at a version that exists', () => {
      for (const workflow of rows('workflow')) {
        expect(workflow['activeVersionId']).toBeTruthy();
        const version = one('workflowVersion', { id: workflow['activeVersionId'] });
        expect(version['workflowId']).toBe(workflow['id']);
      }
    });

    it('numbers the versions of a workflow consecutively from 1', () => {
      for (const workflow of rows('workflow')) {
        const versions = where('workflowVersion', { workflowId: workflow['id'] })
          .map((row) => Number(row['version']))
          .sort((a, b) => a - b);
        expect(versions).toEqual(versions.map((_value, index) => index + 1));
      }
    });

    it('gives every workflow step a tool id inside its config where one is required', () => {
      for (const step of rows('workflowStep')) {
        const config = step['config'] as Record<string, unknown>;
        if (['tool', 'connector', 'mcp', 'browser', 'sandbox', 'notification'].includes(String(step['stepType']))) {
          expect(typeof config['toolId']).toBe('string');
          expect(() => one('tool', { id: config['toolId'] })).not.toThrow();
        }
      }
    });
  });

  describe('tenant isolation', () => {
    it('stamps the seeded tenant on every row that owns one', () => {
      for (const table of TENANT_OWNED_TABLES) {
        for (const row of rows(table)) {
          expect(row['tenantId'], `${table} row ${String(row['id'])}`).toBe(summary.tenantId);
        }
      }
    });

    it('leaves the leaf tables without a tenantId column, as the schema intends', () => {
      for (const table of LEAF_TABLES) {
        for (const row of rows(table)) {
          expect(Object.prototype.hasOwnProperty.call(row, 'tenantId'), table).toBe(false);
        }
      }
    });

    it('writes nothing into a second tenant', () => {
      // The seed creates exactly one workspace. A stray row in another would be a fixture that
      // leaked across the isolation boundary it is supposed to demonstrate.
      expect(rows('tenant')).toHaveLength(1);
    });
  });

  describe('the fixture marker', () => {
    it('marks the rows whose metadata the fixture controls', () => {
      for (const table of ['modelProvider', 'connector']) {
        for (const row of rows(table)) {
          expect((row['metadata'] as Record<string, unknown>)['seededBy']).toBe(SEED_MARKER);
        }
      }
    });
  });

  describe('running it twice', () => {
    it('refuses the second run instead of writing a second copy', async () => {
      const fresh = createFakeDb();
      await runSeed({ config, logger, db: fresh.client, now: NOW });

      const before = Object.fromEntries(
        Object.entries(fresh.tables).map(([table, list]) => [table, list.length]),
      );

      await expect(
        runSeed({ config, logger, db: fresh.client, now: NOW }),
      ).rejects.toBeInstanceOf(SeedAlreadyAppliedError);

      // The guard runs before the first write, so a refused second pass must leave the database
      // byte-identical. A guard placed after the tenant insert would leave an orphan workspace.
      const after = Object.fromEntries(
        Object.entries(fresh.tables).map(([table, list]) => [table, list.length]),
      );
      expect(after).toEqual(before);
    });

    it('names the existing account in the refusal, so the operator knows what it found', async () => {
      const fresh = createFakeDb();
      await runSeed({ config, logger, db: fresh.client, now: NOW });

      await expect(runSeed({ config, logger, db: fresh.client, now: NOW })).rejects.toThrow(
        /dev@nexs\.local/,
      );
    });
  });
});
