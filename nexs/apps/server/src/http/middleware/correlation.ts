import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

const MAX_INCOMING_ID_LENGTH = 128;

/**
 * Every request gets a correlation id. It is echoed back on the response and flows
 * into logs, and later into Run/Step rows and SSE payloads, so a log line can be
 * tied to a database row.
 */
export const correlationId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const id =
    incoming !== undefined && incoming.length > 0 && incoming.length <= MAX_INCOMING_ID_LENGTH
      ? incoming
      : randomUUID();

  req.correlationId = id;
  res.setHeader('x-request-id', id);
  next();
};
