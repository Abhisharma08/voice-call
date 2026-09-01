# Multi-Tenant AI Lead Calling Platform

Control plane for the AI lead-qualification calling platform described in
`docs/Multi_Tenant_AI_Lead_Calling_Platform_PRD_v1.2.pdf`.

**Status: Phase 2 (configuration-driven multi-tenancy) complete.** A lead
flows from a HubSpot-shaped event through intake, the calling queue, an AI
call, LLM qualification and the human-review gate, out to Google Sheets,
HubSpot and hot-lead routing - and every client-specific difference is now
editable configuration rather than code. Production hardening is Phase 3.

---

## What Phase 0 delivers

PRD 22 defines Phase 0 as: repository, environments, CI/CD; PostgreSQL schema
and migrations; auth/RBAC and tenant middleware; secrets management; base
Next.js admin shell. All five are in place.

| Area | Implementation |
| --- | --- |
| Repository / CI | `.github/workflows/ci.yml` runs typecheck, migrations, tests and build against a real PostgreSQL service |
| Environments | `.env.example`, `docker-compose.yml`, `env()` fails fast on misconfiguration |
| Schema | SQL migrations covering PRD 12, 26.1, 26.2 and 26.3 |
| Tenant isolation | PostgreSQL row-level security on every tenant-scoped table |
| Auth / RBAC | Opaque server-side sessions, scrypt passwords, 5 roles, per-tenant assignments and logged elevations |
| Secrets | Envelope encryption (per-secret data keys wrapped by a master key) |
| PII | Column-level AES-256-GCM plus tenant-salted blind indexes |
| Admin shell | Next.js App Router, PRD 14.1 navigation, tenant switcher, dashboard |

## What Phase 1 adds

PRD 22's Phase 1 is a single-client vertical slice: one HubSpot integration,
one campaign, one voice provider adapter, the three n8n workflows, Sheets and
HubSpot updates, and an end-to-end test lead.

| Area | Implementation |
| --- | --- |
| Intake (FR-010 to FR-014) | `src/lib/leads/intake.ts` - E.164 normalisation, dedupe, quarantine, consent and DNC gate |
| Queue (FR-020 to FR-025) | `src/lib/calling/queue.ts` - `FOR UPDATE SKIP LOCKED` claim, calling windows, concurrency caps, lock expiry |
| Voice provider (PRD 10.4) | `src/lib/providers/voice/` - adapter interface plus a deterministic mock |
| Qualification (FR-030 to FR-034) | `src/lib/qualification/` - Claude structured outputs, rubric scoring, routing |
| Review gate (FR-035, PRD 26.3) | `src/lib/qualification/review.ts` + `/review` queue UI |
| Integrations (PRD 13) | `src/lib/integrations/` - HubSpot, Sheets, transactional outbox with backoff |
| Workflows (PRD 9) | `n8n/W01`-`W04` JSON, importable |
| Service identities | Per-tenant bearer tokens, scoped per workflow |

## What Phase 2 adds

PRD 22's Phase 2 is tenant-scoped config, per-tenant credentials, multiple
campaigns, per-campaign prompts/questions/scoring, tenant dashboards and audit
logs.

| Area | Implementation |
| --- | --- |
| Client onboarding (PRD 14.3) | `/clients` - create a tenant, add agency-managed credentials, track health |
| Campaign configuration | `/campaigns/[id]` - script, questions, rubric, thresholds, windows, retries, destinations, model |
| Config versioning (PRD 9) | Every save bumps `config_version` and snapshots into `campaign_versions` |
| Compliance gate (PRD 17.3) | Consent declaration and a named attestation, both required before a campaign can dial |
| Credentials (PRD 17.1) | `/integrations` - sealed on entry, validated for shape, never read back |
| Staff & elevations (PRD 8.2) | `/settings` - assignments, time-boxed logged elevations |
| KPIs (PRD 21) | `/analytics` - operational, AI-performance and commercial metrics kept apart |
| Audit UI (PRD 17.1) | `/audit` - filterable, append-only |
| Lead & call detail (PRD 14.4) | `/leads/[id]`, `/calls` - consent basis and config version per call |

### Try the whole flow

```bash
npm run db:reset          # migrate + seed + Phase 1 fixtures (prints a service token)
npm run dev

TOKEN=svc_...             # from the seed output
CAMPAIGN=...              # from the seed output

# 1. ingest a lead (the mock provider picks its scenario from the last digit)
curl -X POST localhost:3000/api/webhooks/leads \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"event_id":"evt-1","campaign_ref":"'$CAMPAIGN'","record_id":"hs-1",
       "contact":{"name":"Rahul Sharma","phone":"98765 43210"},
       "consent":{"basis":"opt_in_form","source":"landing_page_form","evidence_ref":"f-1"}}'

# 2. dial, 3. post the provider callback, 4. qualify, 5. drain the outbox
curl -X POST localhost:3000/api/internal/dial    -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"campaign_id":"'$CAMPAIGN'"}'
```

Mock provider scenarios, selected by the last digit of the dialled number:
`0` hot, `1` no answer, `2` busy, `3` not interested, `4` do-not-call,
`5` callback requested, `9` transient provider failure.

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
| `npm run db:migrate` / `db:seed` | Schema and base fixtures |
| `npm run db:seed:phase1` | Dialable campaign, credentials, n8n service token |
| `npm run db:reset` | All of the above from scratch |

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
  0004_phase1_calling.sql      Service tokens, webhook idempotency, queue locks
  0005_phase2_configuration.sql Config provenance, consent declaration, versions
scripts/                migrate / seed / reset
src/db/                 Pools, scoped transactions, typed schema mirror
src/lib/crypto/         KMS envelope encryption, PII, password hashing
src/lib/auth/           Sessions, RBAC, tenant middleware, service tokens
src/lib/leads/          Intake, eligibility, consent and DNC gates
src/lib/calling/        Queue, calling windows, retry ladder, worker, results
src/lib/qualification/  Schema, analysis, scoring, review gate, resolution
src/lib/providers/      Voice provider adapter and the mock implementation
src/lib/integrations/   HubSpot, Google Sheets, transactional outbox
src/lib/campaigns/      Campaign configuration schema, versioning, activation checks
src/lib/actions.ts      Permission + tenant scope + audit wrapper for every write
n8n/                    W01-W04 workflow definitions
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

- **Real voice provider.** Only the `mock` adapter is registered. A carrier
  adapter implements `VoiceProvider` and registers itself; the calling worker
  does not change. Provider choice is a compliance decision (PRD 17.3).
- **Notification transport** (PRD 16). The routing event, the hot-lead payload
  and the masked phone number are produced; the email/Slack delivery is not.
- **Production hardening** (Phase 3): load testing, alerting on the PRD 18.3
  signals, dead-letter replay UI, backup/restore drill, security testing.
- **Live transfer, multi-channel follow-up, A/B testing** (Phase 4).

Navigation entries for the unbuilt surfaces render a placeholder naming the
phase that fills them.

### Compliance gate

`campaigns.compliance_approved_at` exists and is null for every seeded
campaign. PRD 17.3 requires that India outbound campaigns not activate until a
telecom/compliance review confirms the agency's own sender/telemarketer
registration, the consent basis for the client's list, provider arrangement,
DNC handling, recording notices and retention.

The column is in place; **the enforcement that reads it belongs with the
calling worker in Phase 1**, since Phase 0 places no calls. Do not enable
outbound calling before that check exists and the review has actually happened.
