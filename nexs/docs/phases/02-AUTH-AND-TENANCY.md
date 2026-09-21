# Phase 2 — Auth & Tenancy (spec numbering)

**Status: ✅ done.** `v2.md` does **not** change this phase — it adds a *second, parallel* identity
system beside it, which is the thing worth understanding.

## What is built

| Piece | Detail |
|---|---|
| `Tenant` / `User` | Tenant-scoped everything; `User.email` is **globally** unique, not `@@unique([tenantId, email])` |
| Access tokens | JWT via `jose`, short-lived, in an httpOnly cookie (`nexs_at`) |
| Refresh rotation | **Token families** (gap #11): reusing a revoked token revokes the whole family — theft detection |
| Password reset | Hashed, single-use, expiring tokens (gap #12) |
| Cookie hygiene | Named cookies with explicit flags; CORS locked to one origin with credentials |
| Rate limits | Concrete per-route-group values, per user for `/api/chat*` (30/min) and per IP as the outer layer |
| Auth ordering | Proven live: an unmatched route outside the mounts returns **404**, while everything under `/api/chat*` returns **401** — including a *wrong method*, so there is no 404-vs-401 oracle |

### Why `User.email` is globally unique

`POST /api/auth/login` takes only `{ email, password }`. Email alone must therefore identify
exactly one account — otherwise login would need a tenant slug. A tenant may still hold many
users; only cross-tenant email *reuse* is disallowed. This is a deliberate trade recorded in the
schema, not an oversight.

## What `v2.md` adds beside this — a peer identity system

`v2.md` §5.4 and §5.6 introduce an identity that is **not a user** and must not be merged with one:

| | User auth (this phase) | Device pairing (`v2.md` S1/S2) |
|---|---|---|
| Subject | A human with an email and password | A **client**: the Control UI, a CLI, a TUI, a phone |
| Credential | JWT access + rotating refresh family | `DeviceToken.tokenHash` — single-use bootstrap, 10-minute expiry |
| Lifetime | Weeks, renewed | Bootstrap: consumed once. Session: revocable per device |
| Capability | Tenant membership | **Scopes** (`operator.admin`, `operator.approvals`, `operator.read`, `operator.write`, `operator.talk.secrets`, `node`) |
| Revocation | Revoke a token family | Revoke the device → all its tokens die |

**A paired CLI is not a user, and treating it as one is the bug this split prevents.** A device
token has scopes, not a tenant role; it can be revoked without touching anyone's login; and a
`limited` device is the same code path as a `full` one minus `operator.admin`.

### The owner (`operator.admin`) is the second new authority

`v2.md` §5.6: the **command owner** gates privileged slash commands and exec approvals (§4.4). Two
properties must hold:

1. **Ownership is not chat access.** Being the owner grants no ability to read a conversation;
   channel and group rules still apply. The copy must say so, because the obvious misreading —
   "owner can do anything" — is wrong.
2. **Ownership is conferred deliberately, once.** `PairingService.approve({ makeOwner: true })`
   refuses (with `FORBIDDEN`) when an owner already exists or the caller lacks `operator.admin`.
   It is a flag on a decision, never an inference from "no owner exists yet".

Neither the device tokens nor the owner identity exist in the code yet — they are `SURFACES-BUILD-PLAN.md`
S1 (schema, done: `Device` / `DeviceToken` tables) and S4/S6 (flows, not started).

## Acceptance test

Unchanged and passing: two tenants cannot read each other's rows, and an expired refresh token is
rejected with its family revoked on reuse. The v2 extension to write alongside the device work:
a revoked device's token is rejected, and a `limited` device is refused `operator.admin`-gated
operations while a `full` one is allowed.