/**
 * Schedules — work that starts on a timetable.
 *
 * ## Why this page had to exist before the task form made sense
 *
 * `TaskService` validates a `recurring` trigger by looking up the schedule it names, so creating
 * a recurring task required a schedule to already exist. The seven schedule routes had no client,
 * which meant the only way to make one was outside the UI — so the feature was reachable from the
 * API and not from the application.
 *
 * ## A schedule never *is* the work
 *
 * It points at a `task` or a `workflow`, and firing it starts that target. Nothing here carries
 * instructions of its own: the target's configuration is the payload, and a schedule that could
 * override it would be a second place the same run is described. That is why the form asks for a
 * target id and not for a prompt.
 *
 * ## `skipped` is an outcome, and it is rendered as one
 *
 * `POST /:id/fire` answers 200 for both `fired` and `skipped` — a skipped fire is a *successful*
 * request whose answer is "nothing happened, and here is why". Reporting it as a failure would
 * suggest the operator did something wrong when the schedule is simply disabled or its target was
 * deleted after the queue job was created.
 *
 * ## Only UTC, and the form refuses to pretend otherwise
 *
 * `createScheduleSchema` has a `refine` that accepts `timezone` only when it is `UTC`. That is a
 * real limit of the build, not a hint, so the field here is a fixed value with the reason beside
 * it rather than a free-text box that would be refused on submit.
 *
 * ## `nextFireAt` is stored, not derived
 *
 * It is recomputed on every fire and every edit, so `null` means "nothing computed yet". For a
 * one-time schedule that has already run, that is the correct and permanent answer — the table
 * distinguishes the two rather than printing an empty cell.
 */

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ScheduleSummary } from '@nexs/shared';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorBox,
  Field,

  PageHead,
  QueryBoundary,
  StatusBadge,
  Tabs,
} from '../../components/ui';
import { EM_DASH, formatDateTime, formatRelative, shortId } from '../../lib/format';
import { cronShapeErrorFor } from '../../lib/validation';
import {
  useCreateSchedule,
  useDeleteSchedule,
  useFireSchedule,
  useSchedules,
  useSetScheduleEnabled,
} from './queries';

export function SchedulesPage(): ReactNode {
  const [tab, setTab] = useState('all');
  const query = useSchedules();
  const setEnabled = useSetScheduleEnabled();
  const fire = useFireSchedule();
  const remove = useDeleteSchedule();
  /** The last fire's result, so a `skipped` answer is visible rather than silent. */
  const [lastFire, setLastFire] = useState<{ id: string; text: string; ok: boolean } | null>(null);

  return (
    <>
      <PageHead
        title="Schedules"
        subtitle="Firing a schedule starts its target — a task or a workflow. The schedule carries no instructions of its own."
      />

      <QueryBoundary query={query} loadingLabel="Loading schedules…">
        {(schedules) => {
          const enabled = schedules.filter((row) => row.enabled);
          const disabled = schedules.filter((row) => !row.enabled);
          const rows =
            tab === 'enabled' ? enabled : tab === 'disabled' ? disabled : schedules;

          return (
            <>
              <Tabs
                tabs={[
                  { id: 'all', label: 'All', badge: <Badge>{schedules.length}</Badge> },
                  { id: 'enabled', label: 'Enabled', badge: <Badge>{enabled.length}</Badge> },
                  { id: 'disabled', label: 'Disabled', badge: <Badge>{disabled.length}</Badge> },
                ]}
                active={tab}
                onChange={setTab}
              />

              {lastFire !== null ? (
                <div className="banner" role="status" style={{ marginTop: 12 }}>
                  <div className="banner-head">
                    <span className="banner-title">
                      {lastFire.ok ? 'Fired' : 'Not fired'} · <span className="mono">{shortId(lastFire.id)}</span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setLastFire(null)}>
                      ✕
                    </Button>
                  </div>
                  <p className="muted small" style={{ margin: 0 }}>
                    {lastFire.text}
                  </p>
                </div>
              ) : null}

              <div style={{ marginTop: 16 }}>
                <Card flush>
                  {rows.length === 0 ? (
                    <EmptyState
                      title={tab === 'all' ? 'No schedules' : `Nothing ${tab}`}
                      hint="Create one below. A recurring task needs a schedule to name before it can be saved."
                    />
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Kind</th>
                          <th>When</th>
                          <th>Target</th>
                          <th>State</th>
                          <th>Last fired</th>
                          <th>Next</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((schedule) => (
                          <tr key={schedule.id}>
                            <td>
                              <div>{schedule.name}</div>
                              <div className="muted small mono">{shortId(schedule.id)}</div>
                            </td>
                            <td>
                              <Badge tone={schedule.kind === 'recurring' ? 'ok' : 'neutral'}>
                                {schedule.kind === 'recurring' ? 'recurring' : schedule.kind === 'one_time' ? 'one-time' : 'event'}
                              </Badge>
                            </td>
                            <td className="mono small">
                              {schedule.kind === 'recurring'
                                ? schedule.cron
                                : schedule.runAt === null
                                  ? EM_DASH
                                  : formatDateTime(schedule.runAt)}
                              {schedule.kind === 'recurring' ? (
                                <div className="muted" style={{ fontSize: 10.5 }}>
                                  {schedule.timezone}
                                </div>
                              ) : null}
                            </td>
                            <td className="small">
                              <Link to={targetHref(schedule)}>
                                {schedule.targetKind} {shortId(schedule.targetId)}
                              </Link>
                            </td>
                            <td>
                              <span className="row" style={{ gap: 5 }}>
                                <StatusBadge status={schedule.enabled ? 'active' : 'disabled'} />
                              </span>
                            </td>
                            <td className="muted small nowrap">
                              {schedule.lastFiredAt === null
                                ? 'never'
                                : formatRelative(schedule.lastFiredAt)}
                            </td>
                            <td className="small nowrap">
                              <NextFire schedule={schedule} />
                            </td>
                            <td>
                              <span className="row" style={{ gap: 4 }}>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  loading={fire.isPending}
                                  title="Run the target now, without waiting for the timetable"
                                  onClick={() =>
                                    fire.mutate(schedule.id, {
                                      onSuccess: (result) =>
                                        setLastFire({
                                          id: schedule.id,
                                          ok: result.outcome === 'fired',
                                          text:
                                            result.outcome === 'fired'
                                              ? `Started ${result.taskId === undefined ? 'its target' : `task ${shortId(result.taskId)}`}${result.runId === undefined ? '' : ` (run ${shortId(result.runId)})`}.`
                                              : `Skipped: ${result.reason ?? 'the server gave no reason'}.`,
                                        }),
                                    })
                                  }
                                >
                                  Fire
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  loading={setEnabled.isPending}
                                  onClick={() =>
                                    setEnabled.mutate({ id: schedule.id, enabled: !schedule.enabled })
                                  }
                                >
                                  {schedule.enabled ? 'Disable' : 'Enable'}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  loading={remove.isPending}
                                  onClick={() => remove.mutate(schedule.id)}
                                  title="Delete this schedule"
                                >
                                  Delete
                                </Button>
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              </div>

              {fire.isError ? (
                <ErrorBox
                  message={fire.error instanceof Error ? fire.error.message : 'The fire failed.'}
                />
              ) : null}
              {setEnabled.isError ? (
                <ErrorBox message="The schedule could not be switched." />
              ) : null}
              {remove.isError ? (
                <ErrorBox message="The schedule could not be deleted." />
              ) : null}

              <div style={{ marginTop: 16 }}>
                <CreateScheduleCard />
              </div>

              <div style={{ marginTop: 16 }}>
                <Card title="What a skipped fire means">
                  <p className="muted small">
                    A fire answers <code>fired</code> or <code>skipped</code>, and both are
                    successful requests. A skip means the schedule is disabled or its target was
                    deleted after the queue job was created — a normal thing to meet, and one the
                    engine deliberately does not retry, because a job that can never succeed should
                    not be re-queued forever.
                  </p>
                </Card>
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}

/**
 * The next fire, or why there is not one.
 *
 * `nextFireAt` is a stored column recomputed on every fire and every edit, so `null` means
 * "nothing computed yet". For a **one-time** schedule that has already fired, that is permanent
 * and correct — the row says so instead of showing a blank that reads like a bug.
 */
function NextFire({ schedule }: { schedule: ScheduleSummary }): ReactNode {
  if (schedule.nextFireAt !== null) {
    return (
      <span title={formatDateTime(schedule.nextFireAt)}>
        {formatRelative(schedule.nextFireAt)}
      </span>
    );
  }
  if (schedule.kind === 'one_time' && schedule.lastFiredAt !== null) {
    return (
      <span className="muted" title="A one-time schedule does not fire again">
        done
      </span>
    );
  }
  if (!schedule.enabled) {
    return (
      <span className="muted" title="Disabled schedules do not fire">
        paused
      </span>
    );
  }
  return (
    <span className="muted" title="The server has not recomputed a next fire yet">
      not computed
    </span>
  );
}

/** Where a target's own page lives, so "task 3f9a" is clickable rather than a dead id. */
function targetHref(schedule: ScheduleSummary): string {
  return schedule.targetKind === 'workflow'
    ? `/workflows/${schedule.targetId}`
    : `/tasks/${schedule.targetId}`;
}

/**
 * Creating a schedule.
 *
 * ## The two kinds have different required fields, and the form asks for the right one
 *
 * `createScheduleSchema` refines both directions: `recurring` requires `cron`, `one_time`
 * requires `runAt`, and each field is *refused* on the other kind. So the form hides the field
 * that does not apply rather than sending an empty string the server would reject with a message
 * about a field the user never saw.
 *
 * ## The timezone box is not a text field
 *
 * Only `UTC` is accepted today. A free-text box here would look like it accepted anything and
 * then be refused on submit by a `refine` the operator cannot see — so it is rendered as a fixed
 * value with the reason, which is the difference between a limit and a trap.
 *
 * ## `runAt` is a local datetime, converted to ISO
 *
 * `<input type="datetime-local">` reports `2026-09-20T14:30` with no zone, and `z.coerce.date()`
 * would read that as UTC on the server while the operator meant their own clock. `new Date(...)`
 * interprets it in the browser's zone, which is what the person filling the form means — so the
 * conversion happens here and the wire carries an unambiguous instant.
 */
function CreateScheduleCard(): ReactNode {
  const create = useCreateSchedule();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'one_time' | 'recurring'>('recurring');
  /**
   * A **six**-field default, because the schema takes six (second, minute, hour, day, month,
   * weekday) and `cronShapeErrorFor` says so. The obvious-looking `0 9 * * *` is five fields and
   * would be refused by the server — a default that cannot be submitted is worse than no default.
   * `0 0 9 * * *` reads as "09:00 daily".
   */
  const [cron, setCron] = useState('0 0 9 * * *');
  const [runAt, setRunAt] = useState('');
  const [targetKind, setTargetKind] = useState<'task' | 'workflow'>('task');
  const [targetId, setTargetId] = useState('');
  const [enabled, setEnabled] = useState(true);

  const runAtIso = runAt === '' ? null : new Date(runAt).toISOString();
  // Only checked for the kind that uses it: a one-time schedule's cron field is not sent and must
  // not be able to block submission.
  const cronError = kind === 'recurring' ? cronShapeErrorFor(cron) : null;
  const complete =
    name.trim() !== '' &&
    targetId.trim() !== '' &&
    (kind === 'recurring' ? cronError === null : runAtIso !== null);

  return (
    <Card title="New schedule">
      <form
        className="stack-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (!complete) return;
          create.mutate(
            {
              name: name.trim(),
              kind,
              // Only the field the kind uses — the schema refuses the other one outright.
              ...(kind === 'recurring' ? { cron: cron.trim(), timezone: 'UTC' } : {}),
              ...(kind === 'one_time' && runAtIso !== null ? { runAt: runAtIso } : {}),
              targetKind,
              targetId: targetId.trim(),
              enabled,
            },
            {
              onSuccess: () => {
                setName('');
                setTargetId('');
                setRunAt('');
              },
            },
          );
        }}
      >
        <div className="row">
          <Field label="Name">
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nightly report"
              disabled={create.isPending}
            />
          </Field>
          <Field label="Kind" hint="A one-time schedule fires once and is done; a recurring one follows a cron expression.">
            <select
              className="select"
              value={kind}
              onChange={(event) => setKind(event.target.value as 'one_time' | 'recurring')}
              disabled={create.isPending}
            >
              <option value="recurring">recurring</option>
              <option value="one_time">one_time</option>
            </select>
          </Field>
        </div>

        {kind === 'recurring' ? (
          <div className="row">
            <Field
              label="Cron"
              // Corrected from "a 5-field expression, validated server-side": the schema takes
              // **six** fields, and this form checks the *shape* locally while the scheduler owns
              // range validation. The old hint sent users to a rejection with the wrong field count.
              hint='Six fields — second minute hour day month weekday, e.g. "0 */10 * * * *" for every ten minutes. The shape is checked here; ranges are checked by the scheduler.'
            >
              <input
                className="input mono"
                value={cron}
                onChange={(event) => setCron(event.target.value)}
                disabled={create.isPending}
                aria-invalid={cronError !== null}
              />
              {cronError === null ? null : (
                <span className="small" style={{ color: 'var(--status-failed)' }}>
                  {cronError}
                </span>
              )}
            </Field>
            <Field
              label="Timezone"
              hint="Only UTC is accepted in this build — the schema refuses any other zone, so this is a fixed value rather than a field that would be rejected."
            >
              <input className="input mono" value="UTC" readOnly disabled />
            </Field>
          </div>
        ) : (
          <Field
            label="Run at"
            hint="Your local time. It is converted to an exact instant before it is sent, so the server and your clock agree."
          >
            <input
              className="input"
              type="datetime-local"
              value={runAt}
              onChange={(event) => setRunAt(event.target.value)}
              disabled={create.isPending}
            />
          </Field>
        )}

        <div className="row">
          <Field label="Target kind">
            <select
              className="select"
              value={targetKind}
              onChange={(event) => setTargetKind(event.target.value as 'task' | 'workflow')}
              disabled={create.isPending}
            >
              <option value="task">task</option>
              <option value="workflow">workflow</option>
            </select>
          </Field>
          <Field
            label="Target id"
            hint="Copy it from the target's own page URL — /tasks/:id or /workflows/:id. An agent is not a valid target: it needs a task to carry the input."
          >
            <input
              className="input mono"
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
              disabled={create.isPending}
            />
          </Field>
        </div>

        <Checkbox
          checked={enabled}
          onChange={setEnabled}
          label="Enabled"
          hint="A disabled schedule exists and can be fired by hand; it just does not fire itself."
        />

        <div className="row">
          <Button type="submit" size="sm" variant="primary" loading={create.isPending} disabled={!complete}>
            Create
          </Button>
          <span className="muted small">
            The schedule carries no instructions of its own — the target's configuration is what
            runs.
          </span>
        </div>
      </form>

      {create.isError ? (
        <ErrorBox
          message={create.error instanceof Error ? create.error.message : 'The schedule was refused.'}
        />
      ) : null}
    </Card>
  );
}
