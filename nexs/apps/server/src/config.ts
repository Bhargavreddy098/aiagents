import { z } from 'zod';

/**
 * The ONLY module in the codebase that reads `process.env`.
 * Everything else takes `Config` by injection from the composition root.
 */

/**
 * Real boolean parsing.
 * NOTE: `z.coerce.boolean()` is a trap — it is `Boolean(value)`, so the string
 * "false" coerces to `true`. Env vars are always strings, so we parse explicitly.
 */
const booleanFromEnv = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .default(defaultValue)
    .transform((v) => v === true || v === 'true' || v === '1');

const envSchema = z.object({
  // ── core ────────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  TZ: z.string().default('UTC'),

  // ── crypto & auth ───────────────────────────────────────────────────────
  /**
   * The app's only secret.
   *
   * It signs access tokens and, via HKDF, **derives the vault key** that encrypts stored
   * credentials — see `services/vault/vault.service.ts`. There is deliberately no separate
   * `NEXS_MASTER_KEY`: a second secret to generate and keep was a configuration step whose only
   * job was to protect credentials already sitting in a database.
   *
   * Rotating this value therefore makes stored credentials undecryptable. That is the coupling
   * the single secret buys, and it is documented where the derivation happens.
   */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // ── worker, jobs & scheduling ───────────────────────────────────────────
  WORKER_ENABLED: booleanFromEnv(true),
  PGBOSS_SCHEMA: z.string().default('nexs_jobs'),
  TENANT_CONCURRENCY: z.coerce.number().int().positive().default(5),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  CRON_TIMEZONE: z.string().default('UTC'),

  // ── storage & limits ────────────────────────────────────────────────────
  STORAGE_ROOT: z.string().default('./data/storage'),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(25),
  TOOL_RESULT_MAX_KB: z.coerce.number().int().positive().default(64),
  RUN_STALE_AFTER_MS: z.coerce.number().int().positive().default(900_000),
  /**
   * How long a provider reachability probe may take.
   *
   * Shorter than a model call on purpose: the probe is a `GET` on a models endpoint, and the
   * sweep runs every ten minutes over every enabled provider. A probe that can hang for a
   * minute would let a few unreachable providers overrun the whole interval.
   */
  PROVIDER_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_CHAT_PER_MIN: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_DEFAULT_PER_MIN: z.coerce.number().int().positive().default(120),

  // ── mcp ─────────────────────────────────────────────────────────────────
  /** [gap #22] Each stdio server is a child process; the cap bounds the leak. */
  MCP_MAX_STDIO_SERVERS: z.coerce.number().int().positive().default(10),
  MCP_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MCP_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

  // ── sandbox ─────────────────────────────────────────────────────────────
  /**
   * [gap #24] These are `worker_threads` `resourceLimits` values. They have no
   * `child_process` equivalent — see `docs/GAPS-AND-FIXES.md` C3.
   */
  SANDBOX_MAX_OLD_SPACE_MB: z.coerce.number().int().positive().default(128),
  SANDBOX_MAX_YOUNG_SPACE_MB: z.coerce.number().int().positive().default(16),
  SANDBOX_STACK_MB: z.coerce.number().int().positive().default(4),
  SANDBOX_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SANDBOX_MAX_OUTPUT_KB: z.coerce.number().int().positive().default(256),

  // ── browser ─────────────────────────────────────────────────────────────
  BROWSER_HEADLESS: booleanFromEnv(true),
  BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** A full-page screenshot of a heavy page runs to megabytes; the row stores a ref. */
  BROWSER_SCREENSHOT_MAX_KB: z.coerce.number().int().positive().default(2_048),
  /**
   * Ceiling for `extract`/`inspect` text, which is inlined into a prompt rather than moved
   * to storage. A page's `body` text can be megabytes of navigation chrome.
   */
  BROWSER_INLINE_TEXT_MAX_KB: z.coerce.number().int().positive().default(8),

  // ── execution engine ────────────────────────────────────────────────────
  /**
   * [gap #16] The three limits, plus the per-step timeout and the retry budget.
   *
   * `ENGINE_MAX_DURATION_MS` is the run deadline; `RUN_STALE_AFTER_MS` above is a
   * different thing — it is how long a heartbeat may be silent before the reaper assumes
   * the worker died. A run can be well inside its duration budget and still be a zombie.
   */
  ENGINE_MAX_STEPS: z.coerce.number().int().positive().default(25),
  ENGINE_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(50),
  ENGINE_MAX_DURATION_MS: z.coerce.number().int().positive().default(900_000),
  ENGINE_STEP_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  ENGINE_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  /** Bound on a single `http_request` response body, before the result cap applies. */
  HTTP_RESPONSE_MAX_KB: z.coerce.number().int().positive().default(4_096),

  // ── sse ─────────────────────────────────────────────────────────────────
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
  SSE_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(10),

  // ── feature flags ───────────────────────────────────────────────────────
  FEATURE_MCP: booleanFromEnv(true),
  FEATURE_CONNECTORS: booleanFromEnv(true),
  FEATURE_SANDBOX: booleanFromEnv(true),
  FEATURE_BROWSER: booleanFromEnv(true),
  FEATURE_RESEARCH: booleanFromEnv(true),

  // ── search (spec §3.6 `web_search`) ─────────────────────────────────────
  /**
   * `none` by default, and that is deliberate rather than lazy: a search needs a vendor key, so
   * the honest default is "no search" — `web_search` is then not registered at all, instead of
   * being offered to a model and failing on every call. Setting a provider without a key logs a
   * warning and degrades to the same place.
   */
  SEARCH_PROVIDER: z.enum(['none', 'brave']).default('none'),
  SEARCH_API_KEY: z.string().optional(),
  SEARCH_BASE_URL: z.string().default('https://api.search.brave.com'),
  /** What the model gets when it does not ask for a count. */
  SEARCH_MAX_RESULTS: z.coerce.number().int().positive().default(5),
  /** Ceiling for a count the model *did* ask for — a search feeds a prompt, not a database. */
  SEARCH_MAX_RESULTS_CEILING: z.coerce.number().int().positive().default(20),
  SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  SEARCH_MAX_RESPONSE_KB: z.coerce.number().int().positive().default(512),

  // ── research protocol (spec Phase 10.2) ─────────────────────────────────
  /** Sub-questions the research question is decomposed into. */
  RESEARCH_MAX_QUERIES: z.coerce.number().int().positive().default(4),
  /** Pages actually read. The expensive step, and the one worth bounding. */
  RESEARCH_MAX_SOURCES: z.coerce.number().int().positive().default(6),
  RESEARCH_MAX_FINDINGS: z.coerce.number().int().positive().default(8),
  /** Characters of each source inlined into the analysis prompt. */
  RESEARCH_EXCERPT_CHARS: z.coerce.number().int().positive().default(1_200),
  /**
   * The acceptance floor from the spec: "≥3 sources". A run that reads fewer **fails** rather than
   * reporting a thin answer as a success, which is what makes this a criterion and not a wish.
   */
  RESEARCH_MIN_SOURCES: z.coerce.number().int().positive().default(3),
  RESEARCH_PAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** Cap on the extracted text of one page, before it reaches a prompt or a source row. */
  RESEARCH_PAGE_MAX_KB: z.coerce.number().int().positive().default(1_024),

  // ── response cache ──────────────────────────────────────────────────────
  CACHE_DRIVER: z.enum(['postgres', 'none']).default('postgres'),
  CACHE_TTL_SEC: z.coerce.number().int().positive().default(86_400),
});

export type Config = z.infer<typeof envSchema>;

function tryLoadEnv(): void {
  if (typeof process.loadEnvFile !== 'function') return;
  for (const candidate of ['.env', '../../.env', '../.env']) {
    try {
      process.loadEnvFile(candidate);
      break;
    } catch {
      // candidate not found, continue
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) {
    tryLoadEnv();
  }
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  return Object.freeze(parsed.data);
}
