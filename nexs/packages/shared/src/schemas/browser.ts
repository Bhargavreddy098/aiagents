import { z } from 'zod';
import { BROWSER_SESSION_STATUSES } from '../types/browser.js';
import { httpUrl } from './url.js';

/**
 * Browser input schemas.
 *
 * The one rule that shapes this file: **the action body is a discriminated union, not a loose
 * object with optional fields.**
 *
 * The obvious alternative — `{ type, url?, selector?, text?, ... }` — is what the manager's
 * `BrowserAction` union exists to avoid, and re-creating the loose version at the boundary would
 * put the problem back: a `click` with no selector would reach the manager as an action it cannot
 * perform, and the failure would be "the browser did nothing" rather than "you did not say what to
 * click". A discriminated union makes each action's required fields part of the type, so the
 * error names the missing field.
 *
 * The union mirrors `BrowserAction` in `browser-manager.ts` member for member. They must stay in
 * step; a member here with no counterpart there is a 422 the manager produces, which is at least
 * loud, but the reverse — a manager action unreachable from the API — would be silent.
 */

const id = z.string().trim().min(1);

/**
 * How long a navigation waits before it is considered landed.
 *
 * Enumerated rather than a free string because the value is passed to Playwright, which silently
 * treats an unrecognised one as `load` — a typo would therefore work, but mean something other
 * than what was asked for.
 */
const waitUntil = z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']);

const navigateAction = z
  .object({
    type: z.literal('navigate'),
    url: httpUrl,
    waitUntil: waitUntil.optional(),
  })
  .strict();

const clickAction = z.object({ type: z.literal('click'), selector: z.string().trim().min(1).max(2000) }).strict();

const typeAction = z
  .object({
    type: z.literal('type'),
    selector: z.string().trim().min(1).max(2000),
    text: z.string().max(20_000),
    submit: z.boolean().optional(),
  })
  .strict();

const selectAction = z
  .object({
    type: z.literal('select'),
    selector: z.string().trim().min(1).max(2000),
    values: z.array(z.string().max(2000)).min(1).max(64),
  })
  .strict();

const extractAction = z
  .object({
    type: z.literal('extract'),
    selector: z.string().trim().min(1).max(2000),
    attribute: z.string().trim().min(1).max(200).optional(),
    all: z.boolean().optional(),
  })
  .strict();

/**
 * Uploading files into a page.
 *
 * The paths are **server-side** paths that must already be inside the tenant's workdir — the
 * manager resolves them through the file service, and this schema cannot check that. Stating it
 * here is the difference between a caller expecting to send a browser `File` and one who knows to
 * upload the bytes first through `/api/files` and then pass the path.
 */
const uploadAction = z
  .object({
    type: z.literal('upload'),
    selector: z.string().trim().min(1).max(2000),
    files: z.array(z.string().trim().min(1).max(1024)).min(1).max(32),
  })
  .strict();

const downloadAction = z
  .object({ type: z.literal('download'), selector: z.string().trim().min(1).max(2000) })
  .strict();

const screenshotAction = z.object({ type: z.literal('screenshot'), fullPage: z.boolean().optional() }).strict();

/**
 * Waiting.
 *
 * Both fields are optional in the manager's union, but a wait with neither returns instantly and
 * means nothing. The check is applied to the union below rather than to this member, and that is
 * a zod constraint rather than a preference: `discriminatedUnion` requires every option to be a
 * plain `ZodObject`, and `.refine()` produces a `ZodEffects` that it rejects outright. Refining
 * the union after the fact keeps the per-action field errors (which is the whole reason for using
 * a discriminated union) *and* gets the cross-field rule.
 */
const waitAction = z
  .object({
    type: z.literal('wait'),
    selector: z.string().trim().min(1).max(2000).optional(),
    ms: z.coerce.number().int().min(0).max(120_000).optional(),
  })
  .strict();

const inspectAction = z.object({ type: z.literal('inspect') }).strict();
const closeAction = z.object({ type: z.literal('close') }).strict();

export const browserActionSchema = z
  .discriminatedUnion('type', [
    navigateAction,
    clickAction,
    typeAction,
    selectAction,
    extractAction,
    uploadAction,
    downloadAction,
    screenshotAction,
    waitAction,
    inspectAction,
    closeAction,
  ])
  .superRefine((value, ctx) => {
    if (value.type === 'wait' && value.selector === undefined && value.ms === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ms'],
        message: 'a wait needs a selector or a duration — otherwise it returns instantly and means nothing',
      });
    }
  });

/**
 * Opening a session.
 *
 * `url` is optional because a session with no first URL is a legitimate starting point — the
 * operator can navigate afterwards. `agentId`/`runId` are accepted so a session opened from the UI
 * can be attributed the same way one the engine opened is, which is what makes the list readable.
 */
export const openBrowserSessionSchema = z
  .object({
    url: httpUrl.optional(),
    agentId: id.nullable().optional(),
    runId: id.nullable().optional(),
  })
  .strict();

export const listBrowserSessionsSchema = z
  .object({
    status: z.enum(BROWSER_SESSION_STATUSES).optional(),
    runId: id.optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

export const actOnBrowserSessionSchema = z.object({ action: browserActionSchema }).strict();

export type OpenBrowserSessionInput = z.infer<typeof openBrowserSessionSchema>;
export type ListBrowserSessionsQuery = z.infer<typeof listBrowserSessionsSchema>;
export type ActOnBrowserSessionInput = z.infer<typeof actOnBrowserSessionSchema>;
export type BrowserActionInput = z.infer<typeof browserActionSchema>;
