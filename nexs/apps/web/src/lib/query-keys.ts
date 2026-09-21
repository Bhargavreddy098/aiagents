/**
 * Query keys — §6.2, verbatim.
 *
 * Every key in the app comes from here. That is not tidiness: the SSE hook invalidates by
 * key, and a page that built its own array literal would be invalidated only if the
 * literal happened to match character-for-character. One module means one place to be
 * right.
 *
 * Keys are `as const` tuples so `useQuery` infers the narrowest type and a typo in a
 * segment is a compile error rather than a cache miss.
 */

export const queryKeys = {
  auth: {
    me: ['auth', 'me'] as const,
  },
  dashboard: ['dashboard'] as const,
  agents: {
    all: ['agents'] as const,
    one: (id: string) => ['agents', id] as const,
    versions: (id: string) => ['agents', id, 'versions'] as const,
  },
  goals: {
    all: ['goals'] as const,
    one: (id: string) => ['goals', id] as const,
  },
  tasks: {
    all: ['tasks'] as const,
    one: (id: string) => ['tasks', id] as const,
  },
  workflows: {
    all: ['workflows'] as const,
    one: (id: string) => ['workflows', id] as const,
  },
  runs: {
    all: ['runs'] as const,
    one: (id: string) => ['runs', id] as const,
  },
  approvals: {
    all: ['approvals'] as const,
    one: (id: string) => ['approvals', id] as const,
  },
  /**
   * The exec half of the approval surface — standing shell permissions.
   *
   * A child of `approvals` so that deciding an approval with `allow_always` can invalidate both
   * in one call: the decision and the rule it wrote are one event, and a key hierarchy is what
   * makes that one `invalidateQueries` rather than two that a later edit could forget.
   */
  exec: {
    all: ['approvals', 'exec'] as const,
    rules: ['approvals', 'exec', 'rules'] as const,
    /** Parameterised because the page's toggle changes which set the server returns. */
    rules_: (scope: 'active' | 'inactive') => ['approvals', 'exec', 'rules', scope] as const,
  },
  /**
   * Skills — the versioned prompt templates (`types/skills.ts`).
   *
   * A separate top-level key rather than a child of anything: a skill is not a tool, does not
   * carry capabilities, and never enters the approval path. It is its own resource and the
   * sidebar groups it under Capabilities only for navigational convenience.
   */
  skills: {
    all: ['skills'] as const,
    one: (id: string) => ['skills', id] as const,
    versions: (id: string) => ['skills', id, 'versions'] as const,
  },
  /**
   * Events and their subscriptions (`types/automation.ts`).
   *
   * `schedules` already exists as a top-level key and stays one — a schedule and an event are the
   * timetable and the signal, two resources that happen to end in the same handoff.
   */
  events: {
    all: ['events'] as const,
    one: (id: string) => ['events', id] as const,
    subscriptions: ['events', 'subscriptions'] as const,
  },
  /**
   * Folder grants, as distinct from attachments (`types/files.ts`).
   *
   * Both live under the `files` prefix on the wire, but they are different resources with
   * different lifecycles: an attachment is a file you uploaded, a grant is a directory you
   * approved. Two children of `files` rather than one flat key.
   */
  grants: {
    all: ['files', 'grants'] as const,
    entries: (id: string) => ['files', 'grants', id, 'entries'] as const,
  },
  providers: ['providers'] as const,
  models: ['models'] as const,
  tools: {
    all: ['tools'] as const,
    one: (id: string) => ['tools', id] as const,
  },
  mcp: {
    all: ['mcp'] as const,
    one: (id: string) => ['mcp', id] as const,
    resources: (id: string) => ['mcp', id, 'resources'] as const,
    prompts: (id: string) => ['mcp', id, 'prompts'] as const,
  },
  connectors: {
    all: ['connectors'] as const,
    one: (id: string) => ['connectors', id] as const,
  },
  browser: {
    sessions: ['browser', 'sessions'] as const,
  },
  sandbox: {
    sessions: ['sandbox', 'sessions'] as const,
  },
  memory: ['memory'] as const,
  research: {
    all: ['research'] as const,
    one: (id: string) => ['research', id] as const,
  },
  notifications: ['notifications'] as const,
  schedules: ['schedules'] as const,
  chat: {
    messages: ['chat', 'messages'] as const,
    mentions: (q: string, kind: string) => ['chat', 'mentions', q, kind] as const,
    commands: ['chat', 'commands'] as const,
    /**
     * §6.2 has no key for the session list, and the list needs one — the sidebar renders it and
     * `POST /api/chat` can create a session behind its back.
     *
     * It is a child of `chat.messages` rather than a sibling so that invalidating the messages
     * key after a completed turn refreshes the list's `messageCount` and `lastMessageAt` too:
     * those columns are written by the same turn that writes the message, so they are never
     * stale independently.
     */
    sessions: ['chat', 'messages', 'sessions'] as const,
  },
  files: ['files'] as const,
} as const;
