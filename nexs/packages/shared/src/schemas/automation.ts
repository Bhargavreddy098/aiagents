import { z } from 'zod';
import {
  EVENT_TARGET_KINDS,
  SCHEDULE_KINDS,
  SCHEDULE_TARGET_KINDS,
} from '../types/automation.js';
import { isValidCron } from '../cron.js';

/**
 * Input schemas for schedules and events.
 *
 * The conventions from `control.ts` hold here: `.strict()` everywhere, and no `.default()` —
 * a default applied at the boundary is a value the caller never sent being written to a row.
 *
 * ## Why the conditional requirements are `refine`s and not optionality
 *
 * A `one_time` schedule has no `cron`, and a `recurring` one has no `runAt`. Expressing that
 * as four optional fields plus a `superRefine` is the only way to get an error that names
 * the *pair* that is wrong. The alternative — a discriminated union on `kind` — reads well
 * but reports the failure as "no matching member of the union", which tells a caller nothing
 * about which field to add.
 *
 * The refines run in both directions on purpose: a `cron` supplied on a `one_time` schedule
 * is rejected rather than ignored. Silently dropping it would leave the caller believing
 * their schedule repeats.
 */

// ── shared pieces ─────────────────────────────────────────────────────────────

const id = z.string().trim().min(1);
const jsonObject = z.record(z.string(), z.unknown());

/**
 * A query-string boolean.
 *
 * `z.coerce.boolean()` is the tempting spelling and it is wrong: it is `Boolean(value)`, so
 * the string `"false"` becomes `true` and every filter silently inverts. The enum makes the
 * accepted spellings explicit.
 */
const queryBoolean = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

// ── schedules ─────────────────────────────────────────────────────────────────

export const createScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(SCHEDULE_KINDS),
    cron: z.string().trim().min(1).max(200).nullable().optional(),
    runAt: z.coerce.date().nullable().optional(),
    /**
     * IANA zone. Only `UTC` is accepted today — see the `refine` below for why.
     */
    timezone: z.string().trim().min(1).max(64).optional(),
    targetKind: z.enum(SCHEDULE_TARGET_KINDS),
    targetId: id,
    /** Set when `kind` is `event`. */
    eventSubscriptionId: id.nullable().optional(),
    /** v2 §10: where a fired schedule's output is delivered. Null means nowhere. */
    deliveryTarget: jsonObject.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.kind !== 'recurring' || (value.cron !== undefined && value.cron !== null),
    { message: 'a recurring schedule requires "cron"', path: ['cron'] },
  )
  .refine((value) => value.kind === 'recurring' || value.cron === undefined || value.cron === null, {
    message: '"cron" only applies to a recurring schedule',
    path: ['cron'],
  })
  .refine(
    (value) =>
      value.cron === undefined || value.cron === null || isValidCron(value.cron),
    { message: 'cron must be a valid 5-field expression, e.g. "*/10 * * * *"', path: ['cron'] },
  )
  .refine(
    (value) => value.kind !== 'one_time' || (value.runAt !== undefined && value.runAt !== null),
    { message: 'a one-time schedule requires "runAt"', path: ['runAt'] },
  )
  .refine((value) => value.kind === 'one_time' || value.runAt === undefined || value.runAt === null, {
    message: '"runAt" only applies to a one-time schedule',
    path: ['runAt'],
  })
  .refine(
    (value) =>
      value.kind !== 'event' ||
      (value.eventSubscriptionId !== undefined && value.eventSubscriptionId !== null),
    { message: 'an event schedule requires "eventSubscriptionId"', path: ['eventSubscriptionId'] },
  )
  .refine(
    (value) =>
      value.kind === 'event' ||
      value.eventSubscriptionId === undefined ||
      value.eventSubscriptionId === null,
    { message: '"eventSubscriptionId" only applies to an event schedule', path: ['eventSubscriptionId'] },
  )
  .refine((value) => value.timezone === undefined || value.timezone.toUpperCase() === 'UTC', {
    // Refused rather than stored-and-ignored. pg-boss would fire the job in the requested
    // zone, but `nextFireAt` is computed by this package in UTC (see `cron.ts`), so a
    // non-UTC schedule would report a next fire that is wrong by the zone's offset. A
    // schedule list that lies about when things run is worse than one that cannot be
    // created in a foreign zone yet.
    message: 'only the "UTC" timezone is supported today (non-UTC next-fire times are not computed)',
    path: ['timezone'],
  });

/**
 * `enabled` is deliberately absent from the update schema.
 *
 * Enable/disable is its own endpoint (`POST /:id/enable`, `POST /:id/disable`), because it
 * has a side effect the other edits do not: it registers or removes a pg-boss job. Folding
 * it into a general patch would mean a caller editing a schedule's name also has to be
 * trusted to get the queue registration right.
 */
export const updateScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    cron: z.string().trim().min(1).max(200).optional(),
    runAt: z.coerce.date().optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    deliveryTarget: jsonObject.nullable().optional(),
  })
  .strict()
  .refine((value) => value.cron === undefined || isValidCron(value.cron), {
    message: 'cron must be a valid 5-field expression, e.g. "*/10 * * * *"',
    path: ['cron'],
  });

export const listSchedulesSchema = z
  .object({
    enabled: queryBoolean,
    kind: z.enum(SCHEDULE_KINDS).optional(),
    targetKind: z.enum(SCHEDULE_TARGET_KINDS).optional(),
    targetId: id.optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

// ── events ────────────────────────────────────────────────────────────────────

/**
 * An inbound event.
 *
 * `payload` and `metadata` are optional and the service writes `{}` for each, so the stored
 * shape is uniform without the schema inventing a value the caller did not send.
 */
export const ingestEventSchema = z
  .object({
    type: z.string().trim().min(1).max(200),
    source: z.string().trim().min(1).max(200),
    subject: z.string().trim().min(1).max(300).nullable().optional(),
    externalId: z.string().trim().min(1).max(300).nullable().optional(),
    payload: jsonObject.optional(),
    metadata: jsonObject.optional(),
    occurredAt: z.coerce.date().optional(),
  })
  .strict();

export const listEventsSchema = z
  .object({
    type: z.string().trim().min(1).optional(),
    source: z.string().trim().min(1).optional(),
    subject: z.string().trim().min(1).optional(),
    processed: queryBoolean,
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

export const createEventSubscriptionSchema = z
  .object({
    topic: z.string().trim().min(1).max(200),
    /**
     * Partial match against the event's `source` and `subject`.
     *
     * A subset of those two fields rather than a general predicate language: a filter
     * expression a model or a UI could compose is a second query language to secure, and
     * the spec asks only for "filter on source/subject".
     */
    filter: z
      .object({
        source: z.string().trim().min(1).max(200).optional(),
        subject: z.string().trim().min(1).max(300).optional(),
      })
      .strict()
      .optional(),
    targetKind: z.enum(EVENT_TARGET_KINDS),
    targetId: id,
    /**
     * Write-only. Accepted on create, never returned — `EventSubscriptionSummary` exposes
     * `hasSecret` instead. An HMAC key that can be read back is one that can be used to
     * forge the webhooks it exists to authenticate.
     */
    secret: z.string().trim().min(16).max(400).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const updateEventSubscriptionSchema = z
  .object({
    topic: z.string().trim().min(1).max(200).optional(),
    filter: z
      .object({
        source: z.string().trim().min(1).max(200).optional(),
        subject: z.string().trim().min(1).max(300).optional(),
      })
      .strict()
      .optional(),
    enabled: z.boolean().optional(),
    secret: z.string().trim().min(16).max(400).optional(),
  })
  .strict();

export const listEventSubscriptionsSchema = z
  .object({
    topic: z.string().trim().min(1).optional(),
    enabled: queryBoolean,
    targetKind: z.enum(EVENT_TARGET_KINDS).optional(),
    targetId: id.optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

// ── inferred input types ──────────────────────────────────────────────────────

export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;
export type ListSchedulesQuery = z.infer<typeof listSchedulesSchema>;

export type IngestEventInput = z.infer<typeof ingestEventSchema>;
export type ListEventsQuery = z.infer<typeof listEventsSchema>;
export type CreateEventSubscriptionInput = z.infer<typeof createEventSubscriptionSchema>;
export type UpdateEventSubscriptionInput = z.infer<typeof updateEventSubscriptionSchema>;
export type ListEventSubscriptionsQuery = z.infer<typeof listEventSubscriptionsSchema>;
