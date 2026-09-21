import { Prisma } from '@prisma/client';

/**
 * Prisma unique-constraint violation (P2002).
 *
 * We let the database be the arbiter of uniqueness rather than doing a
 * check-then-insert, which would race two concurrent signups. That means the
 * caller has to recognise this specific error and translate it into a 409.
 */
export function isUniqueViolation(err: unknown, field?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== 'P2002') return false;
  if (field === undefined) return true;

  const target: unknown = err.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  return target === field;
}
