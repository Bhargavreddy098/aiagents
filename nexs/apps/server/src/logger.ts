import pino from 'pino';
import type { Config } from './config.js';

export function createLogger(config: Config) {
  return pino({
    level: config.LOG_LEVEL,
    base: undefined, // drop pid/hostname noise
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      // secrets must never reach a log line
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        '*.apiKey',
        '*.password',
        '*.token',
        '*.encrypted',
      ],
      remove: true,
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
