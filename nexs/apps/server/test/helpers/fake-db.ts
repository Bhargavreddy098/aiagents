import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * A generic in-memory stand-in for the Prisma client, **derived from Prisma's own
 * DMMF** rather than hand-written per model.
 *
 * Why this shape:
 *  - Stubbing the repositories would test nothing, because tenant isolation, plan
 *    validation and refresh-token rotation all live *in* that layer.
 *  - A hand-written fake per model would drift from `schema.prisma` silently. Reading
 *    `Prisma.dmmf.datamodel` means adding a model to the schema adds it here for free,
 *    and a column rename cannot leave the fake behind.
 *  - Any query shape the fake does not understand throws loudly instead of quietly
 *    returning something plausible.
 *
 * What it models: `where` (equality + gt/gte/lt/lte/in/not/contains/startsWith/OR/AND),
 * `include` and nested includes, `select`, `orderBy`, `take`/`skip`, `create`,
 * `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `count`,
 * `aggregate`, `groupBy`, unique-constraint violations (P2002), and `$transaction`
 * with rollback for the callback form.
 *
 * Known limitations, all deliberate:
 *  - `$transaction([...])` cannot roll back: its operations have already run by the
 *    time the array reaches `$transaction`. Real atomicity for that path is a Postgres
 *    guarantee.
 *  - Raw SQL is not emulated. `$queryRaw` returns whatever `rawQuery` provides, so the
 *    one place that needs it (vector search) is stubbed explicitly per test.
 *  - No referential integrity: nothing stops a row pointing at a missing parent.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Data = Record<string, unknown>;
type Include = Record<string, unknown>;

/**
 * Typed views of the rows the auth tests inspect directly.
 *
 * The generic `Row` is `Record<string, unknown>`, so `user.passwordHash` would be
 * `unknown` and every assertion on it would need its own cast. Declaring the handful of
 * columns tests actually read keeps the assertions honest and readable — and because
 * these interfaces extend `Row`, they stay assignable wherever a plain row is expected.
 */
export interface UserRow extends Row {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  tokenVersion: number;
}

export interface TenantRow extends Row {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefreshTokenRow extends Row {
  id: string;
  userId: string;
  family: string;
  tokenHash: string;
  revokedAt: Date | null;
  expiresAt: Date;
}

export interface PasswordResetRow extends Row {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

interface FieldMeta {
  name: string;
  type: string;
  isList: boolean;
  isRequired: boolean;
  isUpdatedAt: boolean;
  default: unknown;
  hasDefault: boolean;
}

interface RelationMeta {
  name: string;
  relationName: string;
  model: string;
  isList: boolean;
  fromFields: string[];
  toFields: string[];
}

interface ModelMeta {
  name: string;
  /** Prisma exposes `User` as `db.user`, `MCPTool` as `db.mCPTool`. */
  clientKey: string;
  fields: Map<string, FieldMeta>;
  relations: Map<string, RelationMeta>;
  uniqueSets: string[][];
}

function buildModels(): Map<string, ModelMeta> {
  const models = new Map<string, ModelMeta>();

  for (const model of Prisma.dmmf.datamodel.models) {
    const fields = new Map<string, FieldMeta>();
    const relations = new Map<string, RelationMeta>();

    for (const field of model.fields) {
      if (field.kind === 'object') {
        relations.set(field.name, {
          name: field.name,
          relationName: field.relationName ?? field.name,
          model: field.type,
          isList: field.isList,
          // DMMF types these as `readonly string[]`; the copies keep them mutable.
          fromFields: [...(field.relationFromFields ?? [])],
          toFields: [...(field.relationToFields ?? [])],
        });
        continue;
      }

      fields.set(field.name, {
        name: field.name,
        type: field.type,
        isList: field.isList,
        isRequired: field.isRequired,
        isUpdatedAt: field.isUpdatedAt ?? false,
        default: field.default,
        hasDefault: field.hasDefaultValue,
      });
    }

    // Single-field `@unique` plus every `@@unique` / `@@id` set.
    const uniqueSets: string[][] = model.fields
      .filter((f) => f.isUnique === true && f.kind === 'scalar')
      .map((f) => [f.name]);
    for (const index of model.uniqueIndexes) {
      uniqueSets.push([...index.fields]);
    }

    models.set(model.name, {
      name: model.name,
      clientKey: model.name.charAt(0).toLowerCase() + model.name.slice(1),
      fields,
      relations,
      uniqueSets,
    });
  }

  return models;
}

const MODELS = buildModels();

// ── value helpers ─────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
  );
}

function compare(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  if (typeof av === 'string' && typeof bv === 'string') return av < bv ? -1 : av > bv ? 1 : 0;
  if (av instanceof Date && bv instanceof Date) return 0;
  return 0;
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (!isPlainObject(condition)) return value === condition;

  for (const [op, operand] of Object.entries(condition)) {
    switch (op) {
      case 'equals':
        if (value !== operand) return false;
        break;
      case 'not':
        if (matchesCondition(value, operand)) return false;
        break;
      case 'gt':
        if (compare(value, operand) <= 0) return false;
        break;
      case 'gte':
        if (compare(value, operand) < 0) return false;
        break;
      case 'lt':
        if (compare(value, operand) >= 0) return false;
        break;
      case 'lte':
        if (compare(value, operand) > 0) return false;
        break;
      case 'in':
        if (!Array.isArray(operand) || !operand.some((o) => o === value)) return false;
        break;
      case 'notIn':
        if (Array.isArray(operand) && operand.some((o) => o === value)) return false;
        break;
      case 'contains':
        if (typeof value !== 'string' || !value.includes(String(operand))) return false;
        break;
      case 'startsWith':
        if (typeof value !== 'string' || !value.startsWith(String(operand))) return false;
        break;
      case 'endsWith':
        if (typeof value !== 'string' || !value.endsWith(String(operand))) return false;
        break;
      case 'mode':
        break; // `mode: 'insensitive'` is accepted and treated as case-sensitive
      default:
        throw new Error(`fake-db: unsupported where operator "${op}"`);
    }
  }
  return true;
}

/**
 * Flatten Prisma's compound-unique selector into the columns it stands for.
 *
 * `upsert` on a model with `@@unique([serverId, externalId])` is addressed as
 * `where: { serverId_externalId: { serverId, externalId } }`, and that key is not a column —
 * the generic matcher would look up `row['serverId_externalId']` and then choke on
 * `{ serverId }` as an operator. Prisma generates the compound name by joining the field
 * names with `_`, so recognising it is a matter of checking that every part is a real
 * column of the same model, which also avoids mistaking a genuinely misspelled column for a
 * compound key.
 */
function flattenCompoundWhere(where: Where | undefined, model: ModelMeta): Where | undefined {
  if (where === undefined) return undefined;

  const out: Where = {};
  for (const [key, value] of Object.entries(where)) {
    if (!model.fields.has(key) && key.includes('_') && isPlainObject(value)) {
      const parts = Object.keys(value);
      if (parts.length > 0 && parts.every((part) => model.fields.has(part))) {
        Object.assign(out, value);
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

function matches(row: Row, rawWhere: Where | undefined, model: ModelMeta): boolean {
  // Flattened here rather than at each call site so that nested `AND`/`OR` clauses — which
  // re-enter this function — are normalised too.
  const where = flattenCompoundWhere(rawWhere, model);
  if (where === undefined) return true;

  for (const [key, condition] of Object.entries(where)) {
    if (key === 'AND') {
      const parts = Array.isArray(condition) ? condition : [condition];
      if (!parts.every((p) => matches(row, p as Where, model))) return false;
      continue;
    }
    if (key === 'OR') {
      const parts = Array.isArray(condition) ? condition : [condition];
      if (!parts.some((p) => matches(row, p as Where, model))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matches(row, condition as Where, model)) return false;
      continue;
    }

    if (model.relations.has(key)) {
      throw new Error(
        `fake-db: relation filter "${model.name}.${key}" is not supported — filter on the foreign key instead`,
      );
    }

    if (!matchesCondition(row[key], condition)) return false;
  }

  return true;
}

/** Apply a Prisma `data` payload, honouring `{ increment }` / `{ set }` operators. */
function applyData(row: Row, data: Data): void {
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value)) {
      if ('increment' in value) {
        row[key] = ((row[key] as number | undefined) ?? 0) + (value['increment'] as number);
        continue;
      }
      if ('decrement' in value) {
        row[key] = ((row[key] as number | undefined) ?? 0) - (value['decrement'] as number);
        continue;
      }
      if ('set' in value) {
        row[key] = value['set'];
        continue;
      }
      if ('push' in value) {
        const current = Array.isArray(row[key]) ? (row[key] as unknown[]) : [];
        row[key] = [...current, value['push']];
        continue;
      }
    }
    row[key] = value;
  }
}

// ── the fake ──────────────────────────────────────────────────────────────────

export interface FakeDbOptions {
  /** Stand-in for `$queryRaw`. Defaults to `[]`. */
  rawQuery?: (sql: string, values: unknown[]) => unknown;
  /**
   * Stand-in for `$executeRaw`. Defaults to `0` — "no rows affected".
   *
   * `0` rather than `1` is the honest default: the fake cannot know how many rows a statement
   * would have touched, and a default of `1` would let a caller that checks the count pass without
   * ever exercising the check. A test that needs a write to have landed supplies this.
   */
  executeRaw?: (sql: string, values: unknown[]) => number;
}

export interface FakeDb {
  client: PrismaClient;
  /** Every table, keyed by Prisma client key (`user`, `mCPTool`, …). */
  tables: Record<string, Row[]>;
  /** Convenience accessors for the tables the auth tests use most. */
  tenants: TenantRow[];
  users: UserRow[];
  refreshTokens: RefreshTokenRow[];
  passwordResets: PasswordResetRow[];
}

export function createFakeDb(options: FakeDbOptions = {}): FakeDb {
  const tables: Record<string, Row[]> = {};
  for (const model of MODELS.values()) tables[model.clientKey] = [];

  const counters = new Map<string, number>();
  let idSeq = 0;

  const nextId = (): string => `id_${++idSeq}`;

  function defaultFor(field: FieldMeta): unknown {
    if (!field.hasDefault) return undefined;
    const def = field.default;

    if (isPlainObject(def)) {
      const name = def['name'];
      if (name === 'cuid' || name === 'uuid') return nextId();
      if (name === 'now') return new Date();
      if (name === 'autoincrement') {
        const next = (counters.get(field.name) ?? 0) + 1;
        counters.set(field.name, next);
        return next;
      }
      if (name === 'dbgenerated') return undefined;
      if (Array.isArray(def['args']) && def['args'].length > 0) return def['args'][0];
      return undefined;
    }

    if (field.type === 'Json' && typeof def === 'string') {
      try {
        return JSON.parse(def);
      } catch {
        return def;
      }
    }

    return def;
  }

  function materialise(model: ModelMeta, data: Data): Row {
    const row: Row = {};

    for (const field of model.fields.values()) {
      const supplied = data[field.name];
      if (supplied !== undefined) {
        row[field.name] = supplied;
        continue;
      }

      // `@updatedAt` is maintained by Prisma, not by the caller — and it is a required
      // column with no schema-level default, so it has to be filled before the
      // required-field check below.
      if (field.isUpdatedAt) {
        row[field.name] = new Date();
        continue;
      }

      const fallback = defaultFor(field);
      if (fallback !== undefined) {
        row[field.name] = field.isList && Array.isArray(fallback) ? [...fallback] : fallback;
        continue;
      }

      if (field.isList) {
        row[field.name] = [];
        continue;
      }

      // Required with no default and no value supplied → Prisma would reject this too.
      if (field.isRequired) {
        throw new Error(
          `fake-db: missing required field "${model.name}.${field.name}" (no default, no value)`,
        );
      }

      row[field.name] = null;
    }

    return row;
  }

  function assertUnique(model: ModelMeta, candidate: Row, ignoreId?: unknown): void {
    for (const set of model.uniqueSets) {
      // A unique constraint only applies when every column is non-null.
      if (set.some((f) => candidate[f] === null || candidate[f] === undefined)) continue;

      const clash = tables[model.clientKey]!.some(
        (row) =>
          row['id'] !== ignoreId &&
          set.every((f) => row[f] === candidate[f]) &&
          set.some((f) => candidate[f] !== null && candidate[f] !== undefined),
      );

      if (clash) {
        throw new Prisma.PrismaClientKnownRequestError(
          `Unique constraint failed on the fields: (${set.map((f) => `\`${f}\``).join(',')})`,
          { code: 'P2002', clientVersion: '5.22.0', meta: { target: set } },
        );
      }
    }
  }

  function findOpposite(meta: ModelMeta, relationName: string): RelationMeta {
    for (const relation of meta.relations.values()) {
      if (relation.relationName === relationName && relation.fromFields.length > 0) return relation;
    }
    throw new Error(`fake-db: no owning side found for relation "${relationName}"`);
  }

  function resolveInclude(row: Row, model: ModelMeta, include: Include | undefined): Row {
    if (include === undefined) return { ...row };

    const out: Row = { ...row };

    for (const [key, value] of Object.entries(include)) {
      if (value === false || value === undefined) continue;
      const relation = model.relations.get(key);
      if (relation === undefined) continue;

      const nested =
        isPlainObject(value) && isPlainObject(value['include'])
          ? (value['include'] as Include)
          : undefined;
      // A nested `orderBy` has to be honoured, not ignored. Prisma applies it, so a fake
      // that silently returns insertion order makes a query's ordering untestable — and
      // worse, lets a test pass here while production returns a different order. "Latest
      // version first" and "newest run first" are both this clause.
      const nestedOrderBy = isPlainObject(value) ? value['orderBy'] : undefined;
      const target = MODELS.get(relation.model);
      if (target === undefined) continue;

      if (relation.isList) {
        const opposite = findOpposite(target, relation.relationName);
        const fk = opposite.fromFields[0]!;
        const pk = opposite.toFields[0]!;
        out[key] = applyOrderBy(
          tables[target.clientKey]!.filter((candidate) => candidate[fk] === row[pk]),
          nestedOrderBy,
        ).map((candidate) => resolveInclude(candidate, target, nested));
      } else {
        const fk = relation.fromFields[0]!;
        const pk = relation.toFields[0]!;
        const found = tables[target.clientKey]!.find((candidate) => candidate[pk] === row[fk]);
        out[key] = found === undefined ? null : resolveInclude(found, target, nested);
      }
    }

    return out;
  }

  function project(row: Row, select: Include | undefined, model: ModelMeta): Row {
    if (select === undefined) return row;

    const out: Row = {};
    for (const [key, value] of Object.entries(select)) {
      if (value === false) continue;
      if (model.relations.has(key)) {
        const relation = model.relations.get(key)!;
        const target = MODELS.get(relation.model)!;
        const nestedSelect = isPlainObject(value) && isPlainObject(value['select'])
          ? (value['select'] as Include)
          : undefined;
        const current = row[key];
        if (relation.isList && Array.isArray(current)) {
          out[key] = current.map((r) => project(r as Row, nestedSelect, target));
        } else if (current !== null && current !== undefined) {
          out[key] = project(current as Row, nestedSelect, target);
        } else {
          out[key] = current ?? null;
        }
        continue;
      }
      out[key] = row[key];
    }
    return out;
  }

  function applyOrderBy(rows: Row[], orderBy: unknown): Row[] {
    if (orderBy === undefined) return rows;
    const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];

    return [...rows].sort((a, b) => {
      for (const clause of clauses) {
        if (!isPlainObject(clause)) continue;
        for (const [key, direction] of Object.entries(clause)) {
          const dir = direction === 'desc' ? -1 : 1;
          const result = compare(a[key], b[key]);
          if (result !== 0) return result * dir;
        }
      }
      return 0;
    });
  }

  function paginate(rows: Row[], args: { take?: number; skip?: number }): Row[] {
    let out = rows;
    if (args.skip !== undefined) out = out.slice(args.skip);
    if (args.take !== undefined) out = out.slice(0, args.take);
    return out;
  }

  interface FindArgs {
    where?: Where;
    include?: Include;
    select?: Include;
    orderBy?: unknown;
    take?: number;
    skip?: number;
  }

  function makeDelegate(clientKey: string) {
    const model = [...MODELS.values()].find((m) => m.clientKey === clientKey)!;
    const rows = (): Row[] => tables[clientKey]!;

    const finish = (row: Row, args: { include?: Include; select?: Include }): Row =>
      project(resolveInclude(row, model, args.include), args.select, model);

    return {
      findUnique: ({ where, include, select }: FindArgs): Promise<Row | null> => {
        const found = rows().find((row) => matches(row, where, model));
        return Promise.resolve(found === undefined ? null : finish(found, { include, select }));
      },

      findFirst: ({ where, include, select, orderBy }: FindArgs): Promise<Row | null> => {
        const candidates = applyOrderBy(
          rows().filter((row) => matches(row, where, model)),
          orderBy,
        );
        const first = candidates[0];
        return Promise.resolve(first === undefined ? null : finish(first, { include, select }));
      },

      findMany: ({ where, include, select, orderBy, take, skip }: FindArgs): Promise<Row[]> => {
        const candidates = applyOrderBy(
          rows().filter((row) => matches(row, where, model)),
          orderBy,
        );
        return Promise.resolve(
          paginate(candidates, { take, skip }).map((row) => finish(row, { include, select })),
        );
      },

      create: ({ data, include, select }: { data: Data; include?: Include; select?: Include }): Promise<Row> => {
        const row = materialise(model, data);
        assertUnique(model, row);
        rows().push(row);
        return Promise.resolve(finish(row, { include, select }));
      },

      createMany: ({ data }: { data: Data[] }): Promise<{ count: number }> => {
        const created = data.map((item) => materialise(model, item));
        for (const row of created) assertUnique(model, row);
        rows().push(...created);
        return Promise.resolve({ count: created.length });
      },

      update: ({ where, data, include, select }: FindArgs & { data: Data }): Promise<Row> => {
        const found = rows().find((row) => matches(row, where, model));
        if (found === undefined) {
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
              code: 'P2025',
              clientVersion: '5.22.0',
            }),
          );
        }
        applyData(found, data);
        for (const field of model.fields.values()) {
          if (field.isUpdatedAt) found[field.name] = new Date();
        }
        assertUnique(model, found, found['id']);
        return Promise.resolve(finish(found, { include, select }));
      },

      updateMany: ({ where, data }: { where?: Where; data: Data }): Promise<{ count: number }> => {
        const affected = rows().filter((row) => matches(row, where, model));
        for (const row of affected) {
          applyData(row, data);
          for (const field of model.fields.values()) {
            if (field.isUpdatedAt) row[field.name] = new Date();
          }
        }
        return Promise.resolve({ count: affected.length });
      },

      upsert: ({
        where,
        create,
        update,
        include,
        select,
      }: FindArgs & { create: Data; update: Data }): Promise<Row> => {
        const found = rows().find((row) => matches(row, where, model));
        if (found === undefined) {
          const row = materialise(model, create);
          assertUnique(model, row);
          rows().push(row);
          return Promise.resolve(finish(row, { include, select }));
        }
        applyData(found, update);
        return Promise.resolve(finish(found, { include, select }));
      },

      delete: ({ where, include, select }: FindArgs): Promise<Row> => {
        const index = rows().findIndex((row) => matches(row, where, model));
        if (index === -1) {
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError('Record to delete does not exist.', {
              code: 'P2025',
              clientVersion: '5.22.0',
            }),
          );
        }
        const [removed] = rows().splice(index, 1);
        return Promise.resolve(finish(removed!, { include, select }));
      },

      deleteMany: ({ where }: { where?: Where }): Promise<{ count: number }> => {
        const keep = rows().filter((row) => !matches(row, where, model));
        const removed = rows().length - keep.length;
        rows().length = 0;
        rows().push(...keep);
        return Promise.resolve({ count: removed });
      },

      count: ({ where }: { where?: Where }): Promise<number> =>
        Promise.resolve(rows().filter((row) => matches(row, where, model)).length),

      aggregate: ({
        where,
        _sum,
        _avg,
        _min,
        _max,
        _count,
      }: {
        where?: Where;
        _sum?: Record<string, boolean>;
        _avg?: Record<string, boolean>;
        _min?: Record<string, boolean>;
        _max?: Record<string, boolean>;
        _count?: boolean | Record<string, boolean>;
      }): Promise<Row> => {
        const selected = rows().filter((row) => matches(row, where, model));
        const numbers = (key: string): number[] =>
          selected.map((row) => row[key]).filter((v): v is number => typeof v === 'number');

        const out: Row = {};
        if (_sum !== undefined) {
          out['_sum'] = Object.fromEntries(
            Object.keys(_sum).map((k) => [k, numbers(k).reduce((a, b) => a + b, 0)]),
          );
        }
        if (_avg !== undefined) {
          out['_avg'] = Object.fromEntries(
            Object.keys(_avg).map((k) => {
              const values = numbers(k);
              return [k, values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length];
            }),
          );
        }
        if (_min !== undefined) {
          out['_min'] = Object.fromEntries(
            Object.keys(_min).map((k) => {
              const values = numbers(k);
              return [k, values.length === 0 ? null : Math.min(...values)];
            }),
          );
        }
        if (_max !== undefined) {
          out['_max'] = Object.fromEntries(
            Object.keys(_max).map((k) => {
              const values = numbers(k);
              return [k, values.length === 0 ? null : Math.max(...values)];
            }),
          );
        }
        if (_count !== undefined) {
          out['_count'] = selected.length;
        }
        return Promise.resolve(out);
      },

      groupBy: ({
        by,
        where,
        _count,
        _sum,
        _avg,
        _min,
        _max,
      }: {
        by: string[];
        where?: Where;
        _count?: boolean;
        _sum?: Record<string, boolean>;
        _avg?: Record<string, boolean>;
        _min?: Record<string, boolean>;
        _max?: Record<string, boolean>;
      }): Promise<Row[]> => {
        const selected = rows().filter((row) => matches(row, where, model));
        const groups = new Map<string, Row[]>();

        for (const row of selected) {
          const key = by.map((field) => String(row[field])).join('\u0000');
          const bucket = groups.get(key) ?? [];
          bucket.push(row);
          groups.set(key, bucket);
        }

        const numbers = (bucket: Row[], key: string): number[] =>
          bucket.map((row) => row[key]).filter((v): v is number => typeof v === 'number');

        /**
         * Values `_min`/`_max` can compare, which is a wider set than `_sum`/`_avg` accept.
         *
         * Prisma's `_min` and `_max` work on `DateTime` as well as numbers; `_sum` and `_avg`
         * do not. Filtering these through `numbers`, as this fake used to, made
         * `_max: { createdAt: true }` return `null` instead of the newest timestamp — and a
         * fake that quietly returns `null` where the driver returns a `Date` is exactly how a
         * broken query passes its tests.
         */
        const orderable = (bucket: Row[], key: string): Array<number | Date> =>
          bucket
            .map((row) => row[key])
            .filter((v): v is number | Date => typeof v === 'number' || v instanceof Date);

        const sortKey = (value: number | Date): number =>
          value instanceof Date ? value.getTime() : value;

        return Promise.resolve(
          [...groups.values()].map((bucket) => {
            const out: Row = Object.fromEntries(by.map((field) => [field, bucket[0]![field]]));

            if (_count === true) out['_count'] = bucket.length;
            if (_sum !== undefined) {
              out['_sum'] = Object.fromEntries(
                Object.keys(_sum).map((k) => [k, numbers(bucket, k).reduce((a, b) => a + b, 0)]),
              );
            }
            if (_avg !== undefined) {
              out['_avg'] = Object.fromEntries(
                Object.keys(_avg).map((k) => {
                  const values = numbers(bucket, k);
                  return [k, values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length];
                }),
              );
            }
            if (_min !== undefined) {
              out['_min'] = Object.fromEntries(
                Object.keys(_min).map((k) => {
                  const values = orderable(bucket, k);
                  return [
                    k,
                    values.length === 0
                      ? null
                      : values.reduce((best, v) => (sortKey(v) < sortKey(best) ? v : best)),
                  ];
                }),
              );
            }
            if (_max !== undefined) {
              out['_max'] = Object.fromEntries(
                Object.keys(_max).map((k) => {
                  const values = orderable(bucket, k);
                  return [
                    k,
                    values.length === 0
                      ? null
                      : values.reduce((best, v) => (sortKey(v) > sortKey(best) ? v : best)),
                  ];
                }),
              );
            }

            return out;
          }),
        );
      },
    };
  }

  const delegates: Record<string, unknown> = {};
  for (const model of MODELS.values()) delegates[model.clientKey] = makeDelegate(model.clientKey);

  function snapshot(): Record<string, Row[]> {
    const copy: Record<string, Row[]> = {};
    for (const [key, rows] of Object.entries(tables)) copy[key] = rows.map((row) => ({ ...row }));
    return copy;
  }

  function restore(saved: Record<string, Row[]>): void {
    for (const [key, rows] of Object.entries(saved)) {
      const target = tables[key]!;
      target.length = 0;
      target.push(...rows);
    }
  }

  const client = {
    ...delegates,

    $transaction: async (arg: unknown): Promise<unknown> => {
      // Array form: the operations have already run, so there is nothing to roll back.
      if (typeof arg !== 'function') return Promise.all(arg as Array<Promise<unknown>>);

      const saved = snapshot();
      try {
        return await (arg as (tx: unknown) => Promise<unknown>)(client);
      } catch (err) {
        restore(saved);
        throw err;
      }
    },

    $queryRaw: (strings: unknown, ...values: unknown[]): Promise<unknown> => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      return Promise.resolve(options.rawQuery === undefined ? [] : options.rawQuery(sql, values));
    },
    $executeRaw: (strings: unknown, ...values: unknown[]): Promise<number> => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      return Promise.resolve(options.executeRaw === undefined ? 0 : options.executeRaw(sql, values));
    },
    $disconnect: (): Promise<void> => Promise.resolve(),
  };

  return {
    client: client as unknown as PrismaClient,
    tables,
    get tenants(): TenantRow[] {
      return tables['tenant']! as TenantRow[];
    },
    get users(): UserRow[] {
      return tables['user']! as UserRow[];
    },
    get refreshTokens(): RefreshTokenRow[] {
      return tables['refreshToken']! as RefreshTokenRow[];
    },
    get passwordResets(): PasswordResetRow[] {
      return tables['passwordReset']! as PasswordResetRow[];
    },
  };
}

/** Generate a realistic-looking id for tests that seed rows directly. */
export const fakeId = (): string => randomUUID();
