import { Prisma } from '@prisma/client';

/**
 * Converting a domain value into something a Prisma `Json` column will accept.
 *
 * Prisma types those columns as `InputJsonValue`, a *closed* recursive union:
 * `string | number | boolean | InputJsonObject | InputJsonArray | null`. Three things the
 * engine legitimately holds are not assignable to it:
 *
 *  - `unknown`, which is what a plan step's `config` is, and what a receipt's `evidence`
 *    is — both are deliberately open-ended bags.
 *  - An `interface`. TypeScript gives an implicit index signature to a *type alias* of an
 *    object literal but not to an interface, so `PlanStep` is not assignable to
 *    `InputJsonObject` even though every one of its fields is.
 *  - `undefined` inside an object, which is legal in our types and not in JSON.
 *
 * So the conversion has to be explicit, and it is a real serialisation rather than a
 * cast. That is the honest choice for two reasons: it is *exactly* what Prisma does to
 * the value on write (so nothing about the stored shape is a surprise), and a payload
 * that cannot be stored — a `BigInt`, a cycle — fails here with a useful stack rather
 * than somewhere inside the driver.
 *
 * `undefined` maps to `null` rather than throwing, because `JSON.stringify(undefined)`
 * returns `undefined` (not a string) and `JSON.parse` would then fail with a message
 * about JSON that says nothing about the actual mistake.
 */
export function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/**
 * The same conversion for a nullable `Json` column — with a wrinkle that is worth stating.
 *
 * Prisma does not accept a bare `null` for a `Json?` column. It requires one of two
 * sentinels to say *which* null you mean: `Prisma.DbNull` for a SQL NULL, `Prisma.JsonNull`
 * for the JSON value `null`. Passing `undefined` instead means "no value supplied", which
 * on `create` leaves the column NULL and on `updateMany` leaves it untouched.
 *
 * We choose `undefined`, because in every place the engine writes a nullable Json column
 * the field's history is irrelevant: a step's `input` is written once at creation, and its
 * `output` starts NULL and is only ever set by a completion. "Unset" is therefore both the
 * correct and the safest of the three, and it keeps the caller from having to know which
 * flavour of null Prisma wants this week.
 */
export function toOptionalJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined || value === null ? undefined : toJson(value);
}
