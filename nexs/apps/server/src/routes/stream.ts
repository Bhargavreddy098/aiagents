import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { StreamController } from '../controllers/stream.controller.js';

export interface StreamRouterDeps {
  controller: StreamController;
  authRequired: RequestHandler;
}

/**
 * `/api/stream` — one long-lived `GET` per browser tab.
 *
 * Mounted under the same `authRequired` as every other control-plane router. That matters
 * more here than elsewhere: the connection is authenticated **once**, at open, and then lives
 * for hours. A token that is revoked while a stream is open is not re-checked on every frame,
 * so `closeTenant` exists for the cases where a session is invalidated and the stream must be
 * cut rather than left running.
 */

/** The query parameter an `EventSource` client uses when it cannot send a header. */
const QUERY_TOKEN = 'token';

/**
 * Rewrite a request URL with the `token` parameter removed, preserving its path.
 *
 * Operates on the URL as given rather than rebuilding it from `req.originalUrl`, because a
 * router-level middleware sees `req.url` with the mount prefix already stripped — writing the
 * full path back into `req.url` would send the request to a route that does not exist.
 */
function withoutToken(raw: string): string {
  const queryAt = raw.indexOf('?');
  if (queryAt === -1) return raw;

  const path = raw.slice(0, queryAt);
  const params = new URLSearchParams(raw.slice(queryAt + 1));
  params.delete(QUERY_TOKEN);

  const rest = params.toString();
  return rest.length === 0 ? path : `${path}?${rest}`;
}

/**
 * Accept `?token=` on this router, and nowhere else.
 *
 * ## Why this exists
 *
 * `EventSource` cannot set request headers — the constructor takes a URL and nothing else.
 * So a cross-origin stream, where the `httpOnly` cookie is not sent because there is no
 * same-site relationship to send it with, has exactly one place to put a credential: the
 * query string. The spec names this case explicitly ("cookie auth same-origin, or `?token=`
 * for cross-origin"), so refusing it would make the cross-origin stream impossible rather
 * than merely inconvenient.
 *
 * ## Why it is a promotion rather than a second code path
 *
 * The token is moved into the `Authorization` header, which means `createAuthRequired` runs
 * its **existing** verification — signature, expiry, `tokenVersion`, and the re-read of the
 * account — with no branch of its own. A parallel "if it came from the query string, do these
 * checks instead" path is how a token ends up verified once and trusted twice, and it is also
 * how the strongest check quietly goes missing from the weaker path. One credential, one
 * verifier.
 *
 * ## Why the URL is rewritten and not merely read
 *
 * Two reasons, and both are the kind that look like hygiene and are not:
 *
 *  1. **Logs.** `pino-http` serializes the request when the response *finishes*, reading
 *     `req.url` at that moment. Without the rewrite, every stream connection writes a live
 *     access token into the log line — a credential handed to everyone with log access, for a
 *     connection that may stay open for hours. (This is why the rewrite happens here rather
 *     than being left to the logger's `redact` list: redaction is per-field, and the token is
 *     inside a string.)
 *  2. **Downstream readers.** Express 5's `req.query` is a bare getter that re-parses
 *     `req.url` on every access and is never memoized. So a URL with no `token` in it is a
 *     `req.query` with no `token` in it — the controller's `openStreamSchema` does not have to
 *     know the parameter exists, and cannot accidentally echo it back.
 *
 * The rewrite is scoped to this router. Accepting `?token=` on every route would put
 * credentials into the URL bar, into `Referer` headers, and into every proxy's access log for
 * requests that have no reason to need it.
 *
 * A header that is already present wins: a client that sent both is taken to mean the header,
 * which is the value a proxy is more likely to have stripped and re-added deliberately.
 */
function promoteQueryToken(req: Request, _res: Response, next: NextFunction): void {
  const raw: unknown = req.query[QUERY_TOKEN];

  if (typeof raw === 'string' && raw.length > 0 && req.header('authorization') === undefined) {
    req.headers.authorization = `Bearer ${raw}`;
  }

  req.url = withoutToken(req.url);
  if (typeof req.originalUrl === 'string') {
    req.originalUrl = withoutToken(req.originalUrl);
  }

  next();
}

export function createStreamRouter(deps: StreamRouterDeps): Router {
  const router = Router();

  // Before `authRequired`, necessarily: this middleware's whole job is to make the credential
  // visible to the verifier that is about to run.
  router.use(promoteQueryToken);
  router.use(deps.authRequired);
  router.get('/', deps.controller.open);

  return router;
}
