| # | Gap found | What I added in the spec below |
| --- | --- | --- |
| 1 | SSE event catalog referenced as "§38" but never defined anywhere | Complete events.ts contract: every event name + typed payload |
| 2 | Chat is a first-class path with a "messages list" endpoint, but no ChatMessage table exists in the schema | Added ChatMessage model + /api/chat/messages endpoint |
| 3 | Worker and API are separate processes, but SSE hub is in-memory only — events from the worker can't reach clients | EventBus interface with InMemoryBus (single process) + PgNotifyBus (cross-process via Postgres LISTEN/NOTIFY) |
| 4 | Error codes referenced (errors.ts) but never enumerated | Stable error-code → HTTP status table |
| 5 | Schema has invalid Prisma placeholders (@relation(...), broken EventSubscription FK, missing back-relations) | Fully valid, complete schema.prisma |
| 6 | .env.example incomplete; no config validation code shown | Full env list + zod loadConfig() implementation |
| 7 | No cookie names/flags, CORS rule, or concrete rate-limit values | Defined (nexs_at, nexs_rt, limits per route group) |
| 8 | No storage path convention for uploads/screenshots/sandbox workdirs | ${STORAGE_ROOT}/<tenantId>/… layout |
| 9 | pg-boss queue names never listed (only run.execute appears once) | Full queue registry: run.execute, approval.expire, provider.health, recovery.scan, schedule jobs |
| 10 | Provider lastHealthCheck field exists but no job ever updates it | Periodic provider.health cron job (every 10 min) |
| 11 | JSON shapes left vague: checkpoint, plan, approvalPolicy, success criteria, JWT payload | All shapes concretely defined with TypeScript types |
| 12 | Native tools listed by name but no arg schemas | Full tool table with args/returns + capability & permission vocabularies |
| 13 | Frontend contracts missing: routes, query keys, theme tokens, API client, SSE hook | Complete frontend contract section |
| 14 | No turbo.json, CI workflow, tsconfig, docker-compose, or test-DB strategy shown | All provided as literal artifacts the agent can paste |