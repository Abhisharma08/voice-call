# Multi-Tenant AI Lead Calling Platform

Control plane for the AI lead-qualification calling platform described in
`docs/Multi_Tenant_AI_Lead_Calling_Platform_PRD_v1.2.pdf`.

**Status: Phase 2 (configuration-driven multi-tenancy) complete, and
deployable.** A lead flows from a HubSpot event through intake, the calling
queue, an AI call, LLM qualification and the human-review gate, out to Google
Sheets, HubSpot and hot-lead routing — and every client-specific difference is
editable configuration rather than code. Onboarding a client, minting the token
HubSpot posts with, and choosing the voice and analysis providers are all UI.
Production hardening is Phase 3.

---

## Contents

- [What each phase delivers](#what-each-phase-delivers)
- [Try the whole flow](#try-the-whole-flow)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [HTTP surface](#http-surface)
- [Architecture decisions](#architecture-decisions)
- [Layout](#layout)
- [Testing and CI](#testing-and-ci)
- [Deploying](#deploying)
- [Not built yet](#not-built-yet)

---

## What each phase delivers

### Phase 0 — foundation

PRD 22 defines Phase 0 as: repository, environments, CI/CD; PostgreSQL schema
and migrations; auth/RBAC and tenant middleware; secrets management; base
Next.js admin shell.

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

### Phase 1 — the vertical slice

One HubSpot integration, one campaign, one voice provider adapter, the three
n8n workflows, Sheets and HubSpot updates, and an end-to-end test lead.

| Area | Implementation |
| --- | --- |
| Intake (FR-010 to FR-014) | `src/lib/leads/intake.ts` — E.164 normalisation, dedupe, quarantine, consent record and DNC gate |
| Queue (FR-020 to FR-025) | `src/lib/calling/queue.ts` — `FOR UPDATE SKIP LOCKED` claim, calling windows, concurrency caps, lock expiry |
| Voice provider (PRD 10.4) | `src/lib/providers/voice/` — adapter interface, mock, Sarvam, Twilio |
| Qualification (FR-030 to FR-034) | `src/lib/qualification/` — structured outputs, rubric scoring, routing |
| Review gate (FR-035, PRD 26.3) | `src/lib/qualification/review.ts` + `/review` queue UI |
| Integrations (PRD 13) | `src/lib/integrations/` — HubSpot, Sheets, transactional outbox with backoff |
| Workflows (PRD 9) | `n8n/W01`–`W04` JSON, importable (see `n8n/README.md` — the platform now schedules itself) |
| Service identities | Per-tenant bearer tokens, scoped per workflow |

### Phase 2 — configuration-driven multi-tenancy

Tenant-scoped config, per-tenant credentials, multiple campaigns, per-campaign
prompts/questions/scoring, tenant dashboards and audit logs.

| Area | Implementation |
| --- | --- |
| Client onboarding (PRD 14.3) | `/clients/new` — tenant, campaign, questions and service token in one transaction |
| Client management | `/clients` — agency-managed credentials, health, activation status |
| Campaign configuration | `/campaigns/[id]` — script, questions, rubric, thresholds, windows, retries, destinations, models, dial allowlist |
| Config versioning (PRD 9) | Every save bumps `config_version` and snapshots into `campaign_versions` |
| Activation checklist | A script, at least one question, and somewhere to write the answers — enforced at claim time |
| Credentials (PRD 17.1) | `/integrations` — sealed on entry, validated for shape, never read back |
| Staff & elevations (PRD 8.2) | `/settings` — assignments, time-boxed logged elevations |
| KPIs (PRD 21) | `/analytics` — operational, AI-performance and commercial metrics kept apart, over a selectable 7/30/90-day window |
| Audit UI (PRD 17.1) | `/audit` — filterable, append-only |
| Lead & call detail (PRD 14.4) | `/leads/[id]`, `/calls` — consent basis and config version per call |

---

## Try the whole flow

```bash
npm run db:reset          # migrate + seed + Phase 1 fixtures (prints a service token)
npm run dev

TOKEN=svc_...             # from the seed output
CAMPAIGN=...              # from the seed output

# Post a HubSpot-shaped contact. The call is placed on this request's own
# invocation - there is nothing else to run.
curl -X POST "localhost:3000/api/webhooks/hubspot/leads?campaign=$CAMPAIGN" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '[{"eventId":"evt-1","objectId":"hs-1","properties":{
        "firstname":"Rahul","lastname":"Sharma","phone":"98765 43210",
        "requirement":"2BHK in Noida Extension"}}]'
```

The response returns as soon as intake commits; `/calls` has a `call_attempts`
row moments later. `/api/webhooks/leads` takes this platform's own event shape
and behaves the same way.

Mock provider scenarios, selected by the last digit of the dialled number:
`0` hot, `1` no answer, `2` busy, `3` not interested, `4` do-not-call,
`5` callback requested, `9` transient provider failure. The mock places no
calls, so nothing calls back on its own — `npm run demo` drives the provider
callbacks, qualification and the outbox for a whole set of scenarios at once.

`npm run worker` runs the scheduled sweep locally (retries, callbacks, a
calling window opening, the outbox). It is not needed to see a new lead dial.

### Two HubSpot intake paths

Tier decides which is available:

| Client's HubSpot | Path | Endpoint |
| --- | --- | --- |
| **Free** (no workflows) | Private app subscription, signature-verified | `/api/webhooks/hubspot/events` |
| Professional and above | Workflow *Send a webhook* action | `/api/webhooks/hubspot/leads?campaign=…` |

The free-tier path is the one most clients use. It authenticates with
`X-HubSpot-Signature-v3` rather than a bearer token, resolves the client from
the payload's `portalId`, and fetches the contact's properties over the CRM API
— a subscription event carries only an object id. Which campaign a lead lands
in is routed from a contact property, since one private app has a single
webhook URL for the whole portal.

**Connecting real services** (HubSpot, Google Sheets, a voice provider): see
[`docs/CONNECTING.md`](docs/CONNECTING.md). **Deploying it:**
[`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Quick start

Requires Node 22+ and Docker.

```bash
npm install
cp .env.example .env.local

# generate the four key values in .env.local
node -e 'const c=require("crypto");for(const k of ["KMS_MASTER_KEY","PII_ENCRYPTION_KEY","PII_BLIND_INDEX_KEY","SESSION_SECRET"])console.log(k+"="+c.randomBytes(32).toString("base64"))'

# and the scheduler's shared secret
node -e 'console.log("CRON_SECRET="+require("crypto").randomBytes(32).toString("base64url"))'

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
| `npm run test:db` | Database tests, against the container |
| `npm run db:up` / `db:down` | PostgreSQL container |
| `npm run db:migrate` / `db:seed` | Schema and base fixtures |
| `npm run db:seed:phase1` | Dialable campaign, credentials, service token |
| `npm run db:seed:aluempire` | A real-shaped single-client fixture |
| `npm run db:reset` | All of the above from scratch |
| `npm run worker` | The scheduled sweep, locally — calls `/api/cron/tick` on a timer |
| `npm run demo` | Drives a set of scenarios end to end against the mock provider |
| `npm run tunnel` | A public URL for inbound webhooks, and rewrites `APP_URL` |

---

## Configuration

`.env.example` is the authoritative list, with the reasoning for each value
next to it. The shape of it:

| Group | Values | Required? |
| --- | --- | --- |
| Database | `DATABASE_URL` (owner, migrations only), `DATABASE_URL_APP` (staff requests), `DATABASE_URL_SERVICE` (webhooks and workers), `DB_POOL_MAX` | Yes — three roles, not one |
| Secrets | `KMS_MASTER_KEY`, `KMS_MASTER_KEY_ID`, `KMS_PREVIOUS_KEYS` | Yes |
| PII | `PII_ENCRYPTION_KEY`, `PII_BLIND_INDEX_KEY` | Yes, and must differ from the master key |
| Sessions | `SESSION_SECRET`, `SESSION_TTL_HOURS` | Yes |
| Qualification | `ANTHROPIC_API_KEY` (+ `ANTHROPIC_WORKSPACE_ID` for identity-linked keys), `GEMINI_API_KEY` | Optional — absence degrades to the review queue |
| Voice | `VOICE_WEBHOOK_SECRET`; `TWILIO_*`; `SARVAM_*` | Only for the provider you select |
| Scheduling | `CRON_SECRET` | Yes outside development |
| App | `APP_URL` | Yes, and stable — callback URLs are minted from it |

Two registries decide what a campaign can actually use, and both work the same
way: an adapter registers only when its environment is complete, so selecting
an unconfigured provider fails legibly instead of half-working.

- **Voice** (`src/lib/providers/voice/`): `mock` is always registered and
  places no calls; `sarvam` and `twilio` register when their variables are set.
  Selected per campaign by `campaigns.voice_provider`.
- **Analysis** (`src/lib/qualification/providers/`): resolved from the model id
  in `campaigns.analysis_model` — a `claude-*` id goes to Anthropic, a
  `gemini-*` id to Google. Anthropic is always registered (its absence is the
  documented degraded mode); Gemini registers only with a key.

---

## HTTP surface

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/webhooks/hubspot/events` | `X-HubSpot-Signature-v3` | Free-tier private-app subscription; resolves the tenant from `portalId` |
| `POST /api/webhooks/hubspot/leads?campaign=…` | Service token | HubSpot workflow *Send a webhook* |
| `POST /api/webhooks/leads` | Service token | This platform's own event shape |
| `POST /api/webhooks/voice/[provider]` | Per-provider signature or token | Call results, transcripts, status |
| `POST /api/webhooks/voice/twilio/twiml` | Twilio signature | The conversation Twilio speaks |
| `GET/POST /api/cron/tick` | `CRON_SECRET` bearer | The scheduled sweep — retries, callbacks, windows, outbox |
| `/api/internal/dial`, `/analyze`, `/sync` | Service token | Stage endpoints, idempotent on their own keys |
| `/api/auth/login`, `/logout`, `/api/tenant` | Session cookie | Admin shell |
| `/api/leads/reveal`, `/api/review/resolve` | Session cookie + permission | Audited actions |
| `GET /api/health` | None (detail: `CRON_SECRET`) | Liveness and readiness; migration/provider detail only for an authenticated caller |

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
- The application connects as `app_user` or `app_service` — never as the table
  owner — so the policies actually apply. `FORCE` closes the owner loophole
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

`src/proxy.ts` only checks that a session cookie is present. Next.js 16
deprecated the `middleware` file convention in favour of `proxy`, which also
changed the default runtime from edge to Node.js — so the old reason this
could not reach the database is gone, but not the reason it should not. Next's
own guidance is that a proxy may be "deployed to your CDN", so whatever it
concludes is a hint rather than a fact the application may rely on. It is a
redirect convenience, not a security boundary.

### Staff are scoped by assignment, not by employment

PRD 8.2 is explicit that agency staff should not reach every client by default
just because "the agency has access to everything". `users` therefore carries no
meaningful tenant of its own; scope comes from `user_tenant_assignments`, and
anything outside that set requires a row in `access_elevations` — time-boxed,
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
therefore stores a **blind index** — a keyed HMAC of the normalised value —
alongside the ciphertext. It is tenant-salted, so the same phone number
produces a different index per client and one tenant's index cannot probe
another's rows.

`phone_last4` is stored separately for list views; the full number requires an
explicit reveal, which is an audited action. The lead's own enquiry text
(migration 0009) is encrypted the same way: it is free text a member of the
public typed into a form, so it can easily contain an address or a name.

### The audit log is append-only

Migration 0002 grants `SELECT` and `INSERT` on `audit_events` to the runtime
roles and nothing else, so an operator cannot edit or delete their own trail.
Prefer `auditInTx()` over `recordAudit()`: writing the audit row inside the
transaction it describes means the log cannot claim something that was rolled
back.

### Consent is recorded, never demanded again

Consent is collected at the landing page or lead form before the lead ever
reaches HubSpot. Requiring a second, manual consent step here was friction that
recorded nothing the funnel had not already established, and it suppressed real
leads as `no_consent` for a permission that had in fact been given.

So migrations 0006 and 0008 dropped the *gate* and kept the *record*: intake
writes a `consents` row for every lead, derived from where the lead came from,
so a call can cite the specific basis it was placed under (PRD 26.1). The row
is honest about its provenance — `captured_by = 'inherited_upstream'` says the
agency did not run the opt-in funnel and has not independently verified it.

What still stops a call is a **withdrawal**: an explicit opt-out or a DNC
request after the form. That is a different permission from the one the form
collected, and it is untouched.

### The pre-authentication surface has a ceiling, and it is shared

Three endpoints do real work before they know who is calling. `/api/auth/login`
verifies a password with scrypt at N = 2^16 — roughly 300ms of CPU and 64MB of
memory per attempt, which is what makes a stolen hash expensive to crack and
also what makes an unmetered login the cheapest way to exhaust an instance. The
HubSpot and voice webhooks resolve a portal and unseal that client's credential
*before* a signature can be checked, because the signature is verified with the
client's own secret.

The counter is a row in PostgreSQL (migration 0011), not a `Map` in the
process. On a serverless platform an in-process limiter is not a weaker limit,
it is *no* limit: every warm instance holds its own memory, so a ceiling of 10
becomes 10 × however many instances the platform decided to run — a number the
application neither chooses nor observes — and it resets on every cold start,
which is exactly when a flood is arriving.

`app.rate_limit_consume()` does the check and the increment in one statement,
so two concurrent requests cannot both read 9 and both write 10. Login is
limited per address *and* per account: the first bounds a flood, the second
catches a distributed guess at one known address, and evaluation stops at the
first denial so an attacker cannot lock a real user out of their own account by
flooding the address rule.

It **fails open**. Every endpoint it protects needs the same database to do its
actual work, so a limiter that cannot reach PostgreSQL is guarding a request
that was going to fail anyway; failing closed would turn a database blip into a
total outage of lead intake, dropping real leads to defend against an attacker
who could not have got one ingested either.

Per-address limits are only as trustworthy as the proxy in front of the app.
Behind Vercel they are, because the platform sets those headers and replaces
whatever the client sent. Exposed directly to the internet they are not — which
is why the per-account login rule is keyed on the email instead.

### A lead dials itself; the scheduler is a safety net

PRD G2 targets p95 under 30 seconds from CRM ingestion to dial. The queue could
always deliver that — `next_call_at` is `now()` the moment intake commits — but
nothing asked it to. Something had to tick, and the only thing that did was a
scheduler running once a minute, which spends most of that budget waiting.

So the webhook that receives a lead places the call, after its own response:
`after()` in the route, `waitUntil` underneath. HubSpot is acknowledged in
milliseconds and never waits on a carrier.

What makes that safe is that it is an optimisation, not a mechanism. The lead
is durably `queued` before the response goes out, and everything that makes
calling correct is a row rather than a timer: the claim is `FOR UPDATE SKIP
LOCKED` with a lock expiry, retries and backoff are columns, the endpoints are
idempotent on their own keys. If the post-response work never runs — a dropped
invocation, a platform that does not support it — the next sweep places the
same call. Nothing in the pipeline has the dial trigger as its only path.

`/api/cron/tick` is that sweep, and it is what a serverless deployment can
actually run. It covers what no single request can notice: a retry coming due
hours later, a calling window opening, a requested callback, a lead stranded by
an invocation that died mid-call, and the sync outbox clearing after a HubSpot
or Sheets outage. One endpoint for every tenant and every campaign — an idle
client costs nothing, because the pass enumerates outstanding work rather than
looping over clients.

It authenticates with a shared secret rather than a service token, which is the
one privilege boundary it widens: service tokens are per tenant by design (PRD
8.2) and this crosses all of them. So it reads only enough to enumerate work,
then does the work inside per-tenant scopes, and refuses to serve at all when
`CRON_SECRET` is unset rather than defaulting to open.

`scripts/worker.ts` calls that same endpoint on a timer, so what runs locally is
what runs deployed. On Vercel, `vercel.json` schedules it every minute.

### A trial provider account cannot dial a real lead list

Every voice provider's free trial restricts outbound calls to numbers verified
on the account. Pointed at a real lead list, a trial account fails on every
number that is not the tester's own phone — burning an attempt from each lead's
retry budget and filling the queue with opaque provider errors. Worse, a
half-configured staging environment can attempt real people.

Migration 0007 mirrors that constraint inside the platform. When a campaign's
dial allowlist is non-empty, only those numbers may be dialled and everything
else is suppressed with a legible reason, *before* a call is placed. Empty
means no restriction, which is the production case.

### Onboarding a client is one transaction, not four screens and a script

Adding a client used to mean creating a tenant in the UI, creating a campaign,
writing a script and questions by hand, and then running a `scripts/seed-*.ts`
file to mint the service token — because minting one had no UI at all. That is
how client configuration ended up in the repository twice.

`/clients/new` does all of it in one transaction: tenant, assignment, campaign
from a vertical template (`windows_doors`, `real_estate`, `generic`),
qualification questions, and the token HubSpot posts with. A half-onboarded
client is worse than none — a tenant with no campaign is invisible in most of
the UI, and a campaign whose token was never minted looks configured while
HubSpot has no way to reach it.

What onboarding deliberately cannot do is make the campaign dial. It starts
inactive, on the `mock` provider, and returns `activationBlockers()` for the
operator to work through — the destination in particular is a credential
someone has to paste in, which a template cannot supply.

---

## Layout

```
db/migrations/          Authoritative SQL. Forward-only, checksummed.
  0000_roles_and_helpers.sql         Roles, RLS helper functions
  0001_core_schema.sql               PRD 12 data model + 26.1/26.2/26.3
  0002_rls_policies.sql              Policies and least-privilege grants
  0003_auth_lookups.sql              SECURITY DEFINER auth entry points
  0004_phase1_calling.sql            Service tokens, webhook idempotency, queue locks
  0005_phase2_configuration.sql      Config provenance, consent declaration, versions
  0006_consent_inheritance.sql       Consent recorded from the source, not re-asked
  0007_dial_allowlist.sql            Trial-account and staging dial restriction
  0008_consent_recorded_not_required.sql  The consent gate removed entirely
  0009_lead_enquiry.sql              What the lead actually asked for, encrypted
  0010_hubspot_free_tier_intake.sql  Private-app subscriptions, portal resolution
  0011_rate_limiting.sql             Shared counters for the pre-auth surface
  0012_readiness_grants.sql          Migration ledger readable by the runtime roles
scripts/                migrate / seed / reset / worker / tunnel / demo
src/db/                 Pools, scoped transactions, typed schema mirror
src/lib/crypto/         KMS envelope encryption, PII, password hashing
src/lib/auth/           Sessions, RBAC, tenant middleware, service tokens
src/lib/leads/          Intake, eligibility, DNC gate, HubSpot event and campaign routing
src/lib/calling/        Queue, windows, retry ladder, worker, results, post-response dispatch
src/lib/qualification/  Schema, analysis, provider registry, scoring, review gate, resolution
src/lib/providers/      Voice adapter interface: mock, Sarvam, Twilio
src/lib/integrations/   HubSpot (+ signature verification), Google Sheets, Slack, transactional outbox
src/lib/campaigns/      Campaign configuration schema, versioning, activation checks
src/lib/onboarding/     Vertical templates and the one-transaction client setup
src/lib/actions.ts      Permission + tenant scope + audit wrapper for every write
src/lib/audit.ts        Append-only audit trail
src/lib/ratelimit.ts    Shared rate limiting for the pre-authentication surface
src/lib/observability/  Structured logging with redaction
src/instrumentation.ts  Unhandled server errors, as structured lines
src/proxy.ts            Cookie gate (Next 16 renamed `middleware` to `proxy`)
src/app/                Next.js App Router; (admin) is the shell, api/ the HTTP surface
n8n/                    W01-W04 workflow definitions (not in use; see n8n/README.md)
tests/unit/             No database required
tests/db/               Isolation, auth, configuration and vertical slice, against real PostgreSQL
```

`db/migrations` is authoritative. `src/db/schema.ts` is a hand-maintained typed
mirror for query building — RLS policies, partial indexes and check constraints
have no faithful representation in it, so **do not generate DDL from it.**

Migrations are checksummed once applied; editing an applied file fails the next
run. Write a new migration instead.

---

## Testing and CI

```bash
npm run test:unit    # crypto, RBAC, phone, scoring, signatures, providers, onboarding
npm run db:up && npm run db:migrate
npm run test:db      # tenant isolation, auth, configuration, HubSpot intake, vertical slice
```

The database tests are the ones that matter for the isolation claims above:
they assert that a scope-less connection sees nothing, that one tenant's blind
index cannot probe another's rows, and that a denied tenant is indistinguishable
from a missing one. `.github/workflows/ci.yml` runs typecheck, migrations, the
whole suite and a production build against a real PostgreSQL service.

---

## Deploying

[`docs/DEPLOY.md`](docs/DEPLOY.md) walks the whole path on Vercel with managed
PostgreSQL (Neon or Supabase). The order matters: the database has to exist
before the app can boot, and `APP_URL` has to be final before a single call is
placed, because callback URLs are minted from it and Twilio's signature check
compares against it.

Three things are easy to get wrong and worth repeating here:

- **Three database roles, not one.** RLS is only enforced against a non-owner
  role, so an app connecting as the owner has no tenant isolation at all.
- **Pooled connection strings.** Serverless multiplies pools — every warm
  instance holds its own — so point `DATABASE_URL_*` at the pooler host and
  keep `DB_POOL_MAX` small.
- **`CRON_SECRET` must be set.** `/api/cron/tick` returns 503 rather than
  running open without it, and on a serverless platform nothing else dials a
  lead whose retry fell due.

---

## Not built yet

- **A voice provider proven in production.** Three adapters are registered:
  `mock` (always available, places no calls), plus `sarvam` and `twilio`, which
  register only when their environment variables are set — so selecting an
  unconfigured provider fails loudly at claim time rather than dialling through
  something half-set-up. Twilio is telephony only, driving TwiML this app
  serves, and is there for local testing against a phone that actually rings.
  Neither has been run against a production account or volume.
- **Email notifications** (PRD 16). Slack delivery is built - an incoming
  webhook per client, sealed like any other credential, delivered through the
  sync outbox so an outage is a retry rather than a lost hot lead. Email is
  not, and neither is per-campaign routing of who gets told.
- **The rest of Phase 3**: load testing, alerting *on* the PRD 18.3 signals
  (they are now emitted as structured lines, but nothing pages anyone),
  backup/restore drill, security testing. Rate limiting, the dead-letter replay
  UI, structured logging and readiness checks are done.
- **Live transfer, multi-channel follow-up, A/B testing** (Phase 4).

Navigation entries for the unbuilt surfaces render a placeholder naming the
phase that fills them.

### What stops a campaign from calling

Only things that would break the call itself: no opening script, no
qualification questions, or nowhere to write the answers. There is no
compliance sign-off step — consent is collected upstream in the client's own
funnel and recorded on each lead at intake, so `activationBlockers()` never
waits on a human approval.

`src/lib/calling/queue.ts` still refuses to claim a lead for a paused campaign,
and the dial allowlist still suppresses any number not on it, so "calling is
off" is enforcement rather than a label. The `compliance_approved_at` and
consent columns remain on `campaigns`, written only by the retained
`approveCompliance` / `declareConsentBasis` actions, for a client who later
needs a named attestation on file. Nothing reads them to decide whether to
dial.
