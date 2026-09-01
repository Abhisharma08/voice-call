# Multi-Tenant AI Lead Calling Platform

Control plane for the AI lead-qualification calling platform described in
`docs/Multi_Tenant_AI_Lead_Calling_Platform_PRD_v1.2.pdf`.

**Status: Phase 0 (Foundations) complete.** Lead intake, calling and
qualification are Phase 1 and are not built yet.

---

## What Phase 0 delivers

PRD 22 defines Phase 0 as: repository, environments, CI/CD; PostgreSQL schema
and migrations; auth/RBAC and tenant middleware; secrets management; base
Next.js admin shell. All five are in place.

| Area | Implementation |
| --- | --- |
| Repository / CI | `.github/workflows/ci.yml` runs typecheck, migrations, tests and build against a real PostgreSQL service |
| Environments | `.env.example`, `docker-compose.yml`, `env()` fails fast on misconfiguration |
| Schema | 4 SQL migrations covering PRD 12, 26.1, 26.2 and 26.3 |
| Tenant isolation | PostgreSQL row-level security on every tenant-scoped table |
| Auth / RBAC | Opaque server-side sessions, scrypt passwords, 5 roles, per-tenant assignments and logged elevations |
| Secrets | Envelope encryption (per-secret data keys wrapped by a master key) |
| PII | Column-level AES-256-GCM plus tenant-salted blind indexes |
| Admin shell | Next.js App Router, PRD 14.1 navigation, tenant switcher, dashboard |

---

## Quick start

Requires Node 22+ and Docker.

```bash
npm install
cp .env.example .env.local

# generate the four key values in .env.local
node -e 'const c=require("crypto");for(const k of ["KMS_MASTER_KEY","PII_ENCRYPTION_KEY","PII_BLIND_INDEX_KEY","SESSION_SECRET"])console.log(k+"="+c.randomBytes(32).toString("base64"))'

npm run db:up        # PostgreSQL 17 on localhost:5434
npm run db:migrate
npm run db:seed
npm run dev          # http://localhost:3000
```

Seeded logins, all with password `devpassword123`:

| Email | Role | Scope |
| --- | --- | --- |
| `admin@agency.test` | Agency Admin | all clients |
| `ops@agency.test` | Operations Manager | Acme + Northwind |
| `campaigns@agency.test` | Campaign Manager | Acme only |
| `analyst@agency.test` | Analyst | Acme only, read-only |

Signing in as the Campaign Manager and as the Agency Admin shows the isolation
model immediately: the former sees one client in the switcher, the latter sees
both.

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (unit + database) |
| `npm run test:unit` | Unit tests only, no database needed |
| `npm run db:up` / `db:down` | PostgreSQL container |
| `npm run db:migrate` / `db:seed` / `db:reset` | Schema and fixtures |

---

## Architecture decisions

### Tenant isolation is enforced by the database, not the application

PRD 8.2 requires that "cross-tenant queries must be structurally prevented, not
merely filtered in the UI", and notes that the real risk here is an internal
operator opening the wrong client's data, not an external attacker.

So isolation lives in PostgreSQL row-level security rather than in `WHERE`
clauses:

- Every tenant-scoped table has `ENABLE` **and** `FORCE ROW LEVEL SECURITY`
  with the same policy: `app.tenant_visible(tenant_id)`.
- The application connects as `app_user` or `app_service` - never as the table
  owner - so the policies actually apply. `FORCE` closes the owner loophole
  too, which is why the seed script has to declare global scope like any other
  actor.
- Tenant scope is carried in transaction-local settings (`set_config(..., true)`)
  established by `withScope()` in `src/db/client.ts`. Transaction-local means a
  pooled connection cannot carry one request's scope into the next request.
- `app.tenant_visible()` fails closed: with no scope set, nothing is visible.

The practical effect is that forgetting a `WHERE tenant_id = ...` returns no
rows instead of returning another client's data.

Only the Agency Admin may set global scope, and even then, entering a specific
client pins the session to that one tenant.

### A tenant id in a request is a request, never authorization

`src/lib/auth/tenant.ts` treats any tenant id arriving from the client as a
*request to enter* that tenant. `requireGrant()` decides, from the user's
assignments and live elevations, and logs the attempt either way. PRD 8.2:
"No workflow or API endpoint may accept an arbitrary tenant_id from a public
client and trust it as authorization."

A denied tenant returns the same 404 and the same message as a tenant that does
not exist (PRD 23.3).

`src/middleware.ts` only checks that a session cookie is present. It runs on
the edge with no database access, so it cannot validate anything - it is a
redirect convenience, not a security boundary.

### Staff are scoped by assignment, not by employment

PRD 8.2 is explicit that agency staff should not reach every client by default
just because "the agency has access to everything". `users` therefore carries no
meaningful tenant of its own; scope comes from `user_tenant_assignments`, and
anything outside that set requires a row in `access_elevations` - time-boxed,
attributed and revocable.

This is a deliberate deviation from the literal `users.tenant_id` in PRD 12:
every persona in PRD 4 is agency staff, since clients never log in (PRD 14.3).

### Authentication reads through SECURITY DEFINER functions

Login has to read `users` before any actor or tenant is known, which RLS
otherwise forbids. Rather than loosening the policy, `app.login_lookup()` and
`app.session_lookup()` (migration 0003) expose exactly the columns those two
steps need. The table stays closed, and there is a single auditable path to a
password hash. `app_service` is denied execute on all of them.

### Secrets use envelope encryption

Each credential gets its own random data key, encrypted with it, and the data
key is wrapped by the master key from `KMS_MASTER_KEY`. Only the wrapped key
and ciphertext reach the database. `KMS_PREVIOUS_KEYS` keeps older records
readable through a rotation.

The secret's `purpose` is bound in as additional authenticated data, so a
HubSpot credential blob cannot be replayed into a voice-provider slot. The
interface mirrors a cloud KMS so Phase 3 can swap in AWS/GCP KMS without
touching callers.

### PII is encrypted per column, with blind indexes for lookup

PRD 26.2 requires encryption "at the database or application layer, not just
the disk/volume level, so a database dump alone does not expose raw phone
numbers or emails". Encryption happens in `src/lib/crypto/pii.ts`, so values
are ciphertext before they reach PostgreSQL.

Encrypted columns cannot be searched, but PRD 12 needs `(tenant_id, phone)`
lookups for deduplication (FR-013) and PRD 17.4 needs DNC lookups. Each lead
therefore stores a **blind index** - a keyed HMAC of the normalised value -
alongside the ciphertext. It is tenant-salted, so the same phone number
produces a different index per client and one tenant's index cannot probe
another's rows.

`phone_last4` is stored separately for list views; the full number requires an
explicit reveal, which is an audited action.

### The audit log is append-only

Migration 0002 grants `SELECT` and `INSERT` on `audit_events` to the runtime
roles and nothing else, so an operator cannot edit or delete their own trail.
Prefer `auditInTx()` over `recordAudit()`: writing the audit row inside the
transaction it describes means the log cannot claim something that was rolled
back.

---

## Layout

```
db/migrations/          Authoritative SQL. Forward-only, checksummed.
  0000_roles_and_helpers.sql   Roles, RLS helper functions
  0001_core_schema.sql         PRD 12 data model + 26.1/26.2/26.3
  0002_rls_policies.sql        Policies and least-privilege grants
  0003_auth_lookups.sql        SECURITY DEFINER auth entry points
scripts/                migrate / seed / reset
src/db/                 Pools, scoped transactions, typed schema mirror
src/lib/crypto/         KMS envelope encryption, PII, password hashing
src/lib/auth/           Sessions, RBAC, tenant middleware
src/lib/audit.ts        Append-only audit trail
src/app/                Next.js App Router; (admin) is the shell
tests/unit/             No database required
tests/db/               Isolation and auth, against a real PostgreSQL
```

`db/migrations` is authoritative. `src/db/schema.ts` is a hand-maintained typed
mirror for query building - RLS policies, partial indexes and check constraints
have no faithful representation in it, so **do not generate DDL from it.**

Migrations are checksummed once applied; editing an applied file fails the next
run. Write a new migration instead.

---

## Not built yet

Phase 0 stops at foundations, deliberately. Absent, with the PRD section that
defines each:

- Lead intake, phone normalisation to E.164, deduplication (FR-010 to FR-014)
- Calling queue, calling windows, retries, concurrency caps (FR-020 to FR-025)
- Voice provider adapter and the AI conversation (PRD 10)
- LLM qualification and scoring (PRD 11), and the review queue UI (PRD 26.3)
- HubSpot and Google Sheets integrations (PRD 13)
- n8n workflows W01 to W04 (PRD 9)
- Notifications and hot-lead routing (PRD 16)

The navigation entries for these render a placeholder naming the phase that
fills them.

### Compliance gate

`campaigns.compliance_approved_at` exists and is null for every seeded
campaign. PRD 17.3 requires that India outbound campaigns not activate until a
telecom/compliance review confirms the agency's own sender/telemarketer
registration, the consent basis for the client's list, provider arrangement,
DNC handling, recording notices and retention.

The column is in place; **the enforcement that reads it belongs with the
calling worker in Phase 1**, since Phase 0 places no calls. Do not enable
outbound calling before that check exists and the review has actually happened.
