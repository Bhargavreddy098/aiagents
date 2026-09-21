import { z } from 'zod';

/**
 * An absolute `http(s)` URL.
 *
 * Extracted because three schemas need it (a provider's `baseUrl`, an MCP server's `url`, and the
 * connector `baseUrl` that arrives with that surface) and three hand-written copies of a URL rule
 * is how three subtly different URL rules happen.
 *
 * Two decisions are worth stating:
 *
 *  - **`z.string().url()` rather than `new URL(...)`.** This package compiles against
 *    `lib: ["ES2022"]`, where the `URL` global is not declared — a `refine` using the constructor
 *    does not typecheck. zod's `.url()` is a regex inside zod itself, so it is both type-safe here
 *    and browser-safe at runtime.
 *  - **The scheme is pinned by a second check.** `.url()` alone accepts `ftp:`, `file:` and
 *    `javascript:`. The first two are useless to a fetch-based adapter; the third is a security
 *    problem waiting for someone to render it. A URL that reaches a request builder in this system
 *    is always one of two schemes, and saying so at the boundary is cheaper than proving it later.
 */
export const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url('must be an absolute http(s) URL')
  .refine((value) => /^https?:\/\//i.test(value), 'must be an absolute http(s) URL');

/** The same rule, but explicitly nullable — `null` means "unset", which is not the same as absent. */
export const httpUrlOrNull = httpUrl.nullable();
