import { z } from 'zod';
import { RESEARCH_PROJECT_STATUSES, RESEARCH_RUN_STATUSES } from '../types/research.js';

/**
 * Research input schemas.
 *
 * A research project is a *question* that outlives any single attempt to answer it, which is why
 * the project and its runs are created by separate calls: the project is the operator's intent
 * ("what is our exposure to X?"), and a run is one agent's attempt at it. Collapsing them into
 * one endpoint would make "ask again, better" impossible without inventing a second project.
 */

const id = z.string().trim().min(1);

/**
 * Opening a research project.
 *
 * `question` is required and `title` is not derived from it. Deriving a title by truncating the
 * question is the tempting shortcut and it produces a list of rows that all begin identically,
 * which is unusable precisely when a workspace has several projects about the same topic.
 */
export const createResearchProjectSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    question: z.string().trim().min(1).max(4_000),
    /** The agent that should do the work. Absent means the caller names a model per run. */
    agentId: id.nullable().optional(),
  })
  .strict();

export const listResearchProjectsSchema = z
  .object({
    status: z.enum(RESEARCH_PROJECT_STATUSES).optional(),
    agentId: id.optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

/**
 * Starting a run against a project.
 *
 * The same escape hatch the task and chat schemas have: a project with an agent resolves its
 * model from the pinned `AgentVersion`, and one without has to name a model because there is
 * nothing else to read it from. The service refuses the combination that can never run rather
 * than letting it become a run that fails a moment later.
 */
export const startResearchRunSchema = z
  .object({
    agentId: id.nullable().optional(),
    /** Required only when neither the project nor the request names an agent. */
    modelId: id.optional(),
  })
  .strict();

export const listResearchRunsSchema = z
  .object({
    projectId: id.optional(),
    status: z.enum(RESEARCH_RUN_STATUSES).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

/**
 * Recording a source a run actually read.
 *
 * `url` is the only required field, and it is not validated as a URL. That is deliberate: a source
 * can legitimately be a file the agent read, an API it called, or a document it was handed, and a
 * schema that insisted on `https://` would force those to be mislabelled as something they are
 * not. `contentRef` is where the bytes live if they were kept.
 */
export const recordResearchSourceSchema = z
  .object({
    url: z.string().trim().min(1).max(2_000),
    title: z.string().trim().max(500).optional(),
    contentRef: z.string().trim().min(1).optional(),
    credibility: z.string().trim().max(200).optional(),
  })
  .strict();

/**
 * Recording a finding, with the sources it rests on.
 *
 * `sourceIds` is what makes a claim checkable rather than asserted, so it is part of the input
 * rather than something derived later — a finding recorded without its citations is a finding
 * nobody can audit, and the service refuses citations to sources the run did not record.
 */
export const recordResearchFindingSchema = z
  .object({
    claim: z.string().trim().min(1).max(4_000),
    evidence: z.unknown().optional(),
    verified: z.boolean().optional(),
    sourceIds: z.array(id).max(50).optional(),
  })
  .strict();

/**
 * Finishing a run.
 *
 * Only the two terminal statuses. `queued` and `running` are not a caller's to set: they are what
 * starting a run means, and accepting them here would let a client walk a finished run backwards.
 */
export const finishResearchRunSchema = z
  .object({
    status: z.enum(['completed', 'failed']),
    result: z.unknown().optional(),
  })
  .strict();

export type CreateResearchProjectInput = z.infer<typeof createResearchProjectSchema>;
export type ListResearchProjectsQuery = z.infer<typeof listResearchProjectsSchema>;
export type StartResearchRunInput = z.infer<typeof startResearchRunSchema>;
export type ListResearchRunsQuery = z.infer<typeof listResearchRunsSchema>;
export type RecordResearchSourceInput = z.infer<typeof recordResearchSourceSchema>;
export type RecordResearchFindingInput = z.infer<typeof recordResearchFindingSchema>;
export type FinishResearchRunInput = z.infer<typeof finishResearchRunSchema>;
