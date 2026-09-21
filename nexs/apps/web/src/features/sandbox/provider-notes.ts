/**
 * What each sandbox provider actually is.
 *
 * ## Why this is its own module
 *
 * The sentence beside a provider name is a **safety claim**, not a label: it is what tells an
 * operator whether the thing that just ran their code was a container or a worker inside the
 * server process. Two surfaces now run code — the Sandbox page and the terminal — and two copies
 * of this wording would be two answers to the same question, drifting the first time one was
 * edited.
 *
 * It also has to be a module rather than an export from `SandboxPage.tsx`, because importing the
 * page would pull its whole render tree into the terminal's chunk.
 */

/**
 * The provider names the server can report, and what each one means.
 *
 * The spec's own wording is that the in-process worker is **development isolation**, and that
 * distinction is kept verbatim: it bounds time and output, and it is not a container and not a
 * boundary to run untrusted code across.
 */
export const PROVIDER_NOTES: Readonly<Record<string, string>> = {
  'in-process': 'In-process worker — development isolation. Not a container.',
  worker_threads: 'Node worker thread — development isolation. Not a container.',
  process: 'Child process — development isolation. Not a container.',
};

/**
 * The note for a provider, including one this build does not know.
 *
 * The fallback names the provider rather than staying silent, so an unfamiliar value reads as
 * "this is something I cannot vouch for" instead of inheriting a reassuring sentence it has not
 * earned.
 */
export function providerNote(provider: string): string {
  return PROVIDER_NOTES[provider] ?? `Provider "${provider}" — no isolation note for this build.`;
}
