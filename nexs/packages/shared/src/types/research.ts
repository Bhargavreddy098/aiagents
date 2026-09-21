/**
 * Research contracts (spec Phase 10; UI/UX v2 §9 `/research`).
 *
 * A research project is an agent answering a question *with provenance*: the sources it actually
 * read, and the findings it made, kept as rows so a claim can be traced to a source rather than
 * asserted. The two halves are a project (the question and its history) and a run (one attempt,
 * which wraps a real engine run).
 */

export const RESEARCH_PROJECT_STATUSES = ['active', 'completed', 'archived'] as const;

export type ResearchProjectStatus = (typeof RESEARCH_PROJECT_STATUSES)[number];

export const RESEARCH_RUN_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;

export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

export interface ResearchSourceSummary {
  id: string;
  url: string;
  title: string | null;
  contentRef: string | null;
  credibility: string | null;
  accessedAt: string;
}

export interface ResearchFindingSummary {
  id: string;
  claim: string;
  evidence: unknown;
  verified: boolean;
  /** The sources a claim rests on — by id, so the UI can cross-link rather than duplicate. */
  sourceIds: string[];
}

export interface ResearchRunSummary {
  id: string;
  projectId: string;
  /** The real engine run this research run wraps — the execution half. */
  runId: string | null;
  status: ResearchRunStatus;
  plan: unknown;
  result: unknown;
  createdAt: string;
  completedAt: string | null;
}

export interface ResearchProjectSummary {
  id: string;
  title: string;
  question: string;
  agentId: string | null;
  status: ResearchProjectStatus;
  resultRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchProjectDetail extends ResearchProjectSummary {
  runs: ResearchRunSummary[];
}

export interface ResearchRunDetail extends ResearchRunSummary {
  sources: ResearchSourceSummary[];
  findings: ResearchFindingSummary[];
}