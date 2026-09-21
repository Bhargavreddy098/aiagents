/**
 * Skill request schemas.
 *
 * The rule that shapes this file: **a version is published, never edited.** So there is no
 * `updateVersionSchema` and no route that accepts a version number as input — the next version is
 * always the highest existing one plus one, decided by the repository inside a transaction rather
 * than proposed by a caller who could pick a number that already exists.
 */

import { z } from 'zod';
import { SKILL_STATUSES } from '../types/skills.js';

const name = z.string().trim().min(1).max(120);

/**
 * The template.
 *
 * Capped generously but capped. An unbounded prompt template is a way to store a novel in a column
 * that the skills list renders inline, and the cap is the only thing standing between that and a
 * page that never loads.
 */
const promptTemplate = z.string().min(1).max(64_000);

/**
 * A JSON Schema for the template's arguments.
 *
 * Validated only as "a JSON object" — this codebase does not take a second opinion on what a JSON
 * Schema may say. `unknown`-typed on the way out for the same reason `ToolDetail.inputSchema` is.
 */
const argsSchema = z.record(z.unknown());

export const createSkillSchema = z
  .object({
    name,
    description: z.string().trim().max(1000).nullable().optional(),
    /**
     * The first version's template.
     *
     * Required, so that a created skill is immediately usable. The alternative — create the row,
     * then publish — leaves a window in which the skill exists with `latestVersion: null`, and a
     * skill nobody can use yet is indistinguishable on screen from one that is broken.
     */
    promptTemplate,
    argsSchema: argsSchema.optional(),
  })
  .strict();

/**
 * Edit a skill's metadata.
 *
 * `promptTemplate` is absent on purpose. Changing what a skill *says* is a new version, and a
 * PATCH that quietly rewrote version 3 in place would falsify every run that already used it.
 */
export const updateSkillSchema = z
  .object({
    name: name.optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    status: z.enum(SKILL_STATUSES).optional(),
  })
  .strict();

/** Publish the next version. The number is the repository's to choose, so it is not accepted here. */
export const createSkillVersionSchema = z
  .object({
    promptTemplate,
    argsSchema: argsSchema.optional(),
  })
  .strict();

export const listSkillsSchema = z
  .object({
    status: z.enum(SKILL_STATUSES).optional(),
    /**
     * Case-insensitive substring match on the name.
     *
     * Present because §5.3's mention picker resolves `kind=skill` from a live query — the same
     * `?q=` contract `/api/chat/mentions` uses — and that picker is prefix-driven.
     */
    q: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type CreateSkillInput = z.infer<typeof createSkillSchema>;
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>;
export type CreateSkillVersionInput = z.infer<typeof createSkillVersionSchema>;
export type ListSkillsQuery = z.infer<typeof listSkillsSchema>;
