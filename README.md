# AI Lead Calling Platform

An open-source, multi-tenant platform that calls inbound leads with an AI voice
agent, qualifies them from the transcript, and writes the result back to the
CRM — with a human review gate in front of anything it is not sure about.

Built for an agency running campaigns on behalf of several clients, so tenancy,
per-client credentials and per-client scoping of staff are load-bearing rather
than bolted on.

```
   HubSpot / webhook              this platform                    back out
 ┌───────────────────┐   ┌──────────────────────────────┐   ┌──────────────────┐
 │  a lead arrives   │──▶│ intake → queue → call →       │──▶│ HubSpot contact  │
 │  (form, ad, CRM)  │   │ transcript → LLM qualify →    │   │ Google Sheet row │
 └───────────────────┘   │ score → route → review gate   │   │ Slack hot lead   │
                         └──────────────────────────────┘   └──────────────────┘
```

**Status:** running end to end against a real CRM and a mock voice provider.
The voice adapters are written but not yet proven at production volume — see
[What is not done](#what-is-not-done).

---

## Contents

- [What it does](#what-it-does)
- [How a lead flows through it](#how-a-lead-flows-through-it)
- [Quick start](#quick-start)
- [Try the whole flow](#try-the-whole-flow)
- [The admin console](#the-admin-console)
- [Configuration](#configuration)
- [HTTP surface](#http-surface)
- [Architecture decisions](#architecture-decisions)
- [Repository layout](#repository-layout)
- [Testing and CI](#testing-and-ci)
- [Deploying](#deploying)
- [What is not done](#what-is-not-done)
- [Contributing](#contributing)
- [Security](#security)
- [Licence](#licence)

---

## What it does

**Calls leads, fast.** A lead arriving from a CRM webhook is dialled on that
same request, not on the next scheduler tick. Target is p95 under 30 seconds
from ingestion to dial.

**Qualifies from the transcript, not from a form.** An LLM reads the
conversation and returns a strict structured result — the answers to the
campaign's own questions, an intent, a confidence. Schema validation happens
before anything is persisted.

**Scores in code, not in the model.** The rubric is arithmetic applied to the
model's extracted fields, so a score is reproducible from the stored payload
and an operator can be shown exactly why a lead was routed the way it was.

**Holds what it is unsure about.** A low-confidence result, a missing required
answer, or a score near a routing boundary goes to a human review queue instead
of the client's CRM. Nothing syncs until a person resolves it.

**Keeps its promises.** A lead who asks to be called back gets a callback row
that stays outstanding until a call actually goes out — see
[docs/CALLBACKS.md](docs/CALLBACKS.md).

**Is genuinely multi-tenant.** Isolation is PostgreSQL row-level security, not
`WHERE` clauses. Each client brings their own CRM credential, their own sheet,
their own voice provider account if they have one. Agency staff are scoped to
the clients they are assigned to.

**Treats personal data as regulated.** Phone numbers, emails, enquiry text and
transcripts are encrypted at the application layer. List views show the last
four digits; revealing a full number is a separate, audited action.

### Feature map

| Area | What is there |
| --- | --- |
| Lead intake | E.164 normalisation, deduplication by blind index, quarantine for unusable records, DNC gate, consent record per lead |
| Calling | `FOR UPDATE SKIP LOCKED` queue, per-campaign calling windows in the campaign's own timezone, tenant and campaign concurrency caps, retry ladder with backoff, lock expiry for crashed workers |
| Voice providers | Adapter interface with `mock`, Sarvam and Twilio implementations; selected per campaign; credentials per client or agency-wide |
| Qualification | Structured outputs against a Zod schema, Anthropic and Gemini adapters, per-campaign model and reasoning effort |
| Scoring & routing | Per-campaign rubric and thresholds, intent taxonomy, hot-lead routing |
| Review gate | Confidence, missing-answer and boundary triggers; confirm / correct / reject, all audited |
| Callbacks | Requested callbacks tracked, kept automatically when the call goes out, swept for misses |
| Integrations | HubSpot (two intake paths, CRM write-back, custom properties), Google Sheets call log, Slack hot-lead notification, transactional outbox with backoff and dead letters |
| Admin console | Clients, campaigns, leads, calls, review queue, callbacks, analytics, integrations, staff, audit log |
| Security | RLS, RBAC with five roles, per-client staff assignment, time-boxed logged elevation, envelope-encrypted secrets, column-level PII encryption, append-only audit, shared rate limiting |

---

## How a lead flows through it

1. **Intake** (`src/lib/leads/intake.ts`) — a webhook delivers a contact. The
   phone is normalised to E.164, checked against this tenant's DNC list and
   existing leads via a tenant-salted blind index, and a consent record is
   written from where the lead came from. An unusable record is quarantined
   with a reason rather than dropped.
2. **Routing** — which campaign the lead belongs to, read from a CRM property
   or the client's single default campaign.
3. **Dial** — the lead is durably `queued`, then the webhook's own invocation
   places the call after responding. The scheduled sweep is the safety net, not
   the trigger.
4. **The call** — the voice provider runs the conversation from the campaign's
   opening script, business context and questions. The platform starts the call
   and reads the result; it does not hold the conversation state.
5. **Result** (`src/lib/calling/results.ts`) — the provider's callback is
   verified, normalised and recorded idempotently. A connected call with a
   transcript goes to qualification; anything else goes to the retry ladder.
6. **Qualification** (`src/lib/qualification/`) — the LLM returns a structured
   result, the rubric scores it in code, and the routing thresholds decide the
   outcome.
7. **The gate** — low confidence, a missing required answer, or a score near a
   boundary holds the result for human review. Everything else commits.
8. **Out** — a committed result is enqueued in the sync outbox for HubSpot,
   Google Sheets and, for a hot lead, Slack. The outbox retries with backoff
   and dead-letters what it cannot deliver.

---

## Quick start

Requires **Node 22+** and **Docker**.

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

Signing in as the Campaign Manager and then as the Agency Admin shows the
isolation model immediately: the former sees one client in the switcher, the
latter sees both.

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
| `npm run db:seed:phase1` | A dialable campaign, credentials and a service token |
| `npm run db:reset` | All of the above from scratch |
| `npm run worker` | The scheduled sweep, locally — calls `/api/cron/tick` on a timer |
| `npm run demo` | Drives a set of scenarios end to end against the mock provider |
| `npm run tunnel` | A public URL for inbound webhooks, and rewrites `APP_URL` |

---

## Try the whole flow

```bash
npm run db:reset          # migrate + seed + fixtures (prints a service token)
npm run dev

TOKEN=svc_...             # from the seed output
CAMPAIGN=...              # from the seed output

# Post a CRM-shaped contact. The call is placed on this request's own
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

Mock provider scenarios are selected by the last digit of the dialled number:
`0` hot, `1` no answer, `2` busy, `3` not interested, `4` do-not-call,
`5` callback requested, `9` transient provider failure. The mock places no
calls, so nothing calls back on its own — `npm run demo` drives the provider
callbacks, qualification and the outbox for a whole set of scenarios at once.

`npm run worker` runs the scheduled sweep locally (retries, callbacks, a
calling window opening, the outbox). It is not needed to see a new lead dial.

---

## The admin console

| Page | What it is for |
| --- | --- |
| **Dashboard** | The five numbers worth checking first, each linking to the page that acts on it |
| **Analytics** | Operational, AI-performance and commercial metrics kept deliberately apart, over a selectable window |
| **Leads** | Every lead, masked, with status, consent, latest intent and next call |
| **Calls** | Every attempt, with the consent basis and config version it ran under |
| **Review Queue** | Results held back from the CRM until a person confirms, corrects or rejects them |
| **Callbacks** | What was promised, what is overdue, what was kept — see [docs/CALLBACKS.md](docs/CALLBACKS.md) |
| **Clients** | Client accounts, onboarding, per-client credentials, activation status |
| **Campaigns** | Script, questions, rubric, thresholds, calling window, retries, destinations, models, dial allowlist — all versioned |
| **Integrations** | Sealed per-client credentials, connection tests, dead-letter replay, voice provider status |
| **Settings** | Staff, client assignments, time-boxed access elevations |
| **Audit Log** | Append-only, filterable by configuration, compliance, sensitive reads, review and access |

Clients never log in. Every account is agency staff or a service identity.

### Roles

| Role | Holds |
| --- | --- |
| **Agency Admin** | Everything, including global scope across clients |
| **Campaign Manager** | Campaign and integration configuration, leads, calls, analytics |
| **Operations Manager** | The review queue, callbacks, DNC, lead writes, sensitive reads |
| **Analyst** | Read-only across leads, calls, campaigns and analytics |
| **Service** | Workflows and workers only, never a human surface |

Being agency staff is not itself authorisation for a given client: scope comes
from an assignment, and anything outside it needs a logged, time-boxed
elevation.

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
| Voice | `VOICE_WEBHOOK_SECRET`; `TWILIO_*`; `SARVAM_*` | Only for an agency-wide provider account |
| Scheduling | `CRON_SECRET` | Yes outside development |
| App | `APP_URL` | Yes, and stable — callback URLs are minted from it |

Two registries decide what a campaign can actually use, and both work the same
way: an adapter registers only when its configuration is complete, so selecting
an unconfigured provider fails legibly instead of half-working.

- **Voice** (`src/lib/providers/voice/`): `mock` is always registered and
  places no calls; `sarvam` and `twilio` register from a client's own sealed
  credential or from the environment. Selected per campaign by
  `campaigns.voice_provider`.
- **Analysis** (`src/lib/qualification/providers/`): resolved from the model id
  in `campaigns.analysis_model` — a `claude-*` id goes to Anthropic, a
  `gemini-*` id to Google. Anthropic is always registered (its absence is the
  documented degraded mode); Gemini registers only with a key.

**Connecting real services** (HubSpot, Google Sheets, a voice provider):
[docs/CONNECTING.md](docs/CONNECTING.md).
**Working the callback queue:** [docs/CALLBACKS.md](docs/CALLBACKS.md).
**Deploying it:** [docs/DEPLOY.md](docs/DEPLOY.md).

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
| `GET /api/health` | None (detail: `CRON_SECRET`) | Liveness and readiness; migration and provider detail only for an authenticated caller |

---

## Architecture decisions

### Tenant isolation is enforced by the database, not the application

Cross-tenant queries have to be structurally prevented rather than merely
filtered in the UI — and the real risk in an agency platform is an internal
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
assignments and live elevations, and logs the attempt either way. No workflow
or API endpoint accepts an arbitrary tenant id from a public client and trusts
it as authorization.

A denied tenant returns the same 404 and the same message as a tenant that does
not exist.

`src/proxy.ts` only checks that a session cookie is present. Next.js 16
deprecated the `middleware` file convention in favour of `proxy`, which also
changed the default runtime from edge to Node.js — so the old reason this
could not reach the database is gone, but not the reason it should not. Next's
own guidance is that a proxy may be "deployed to your CDN", so whatever it
concludes is a hint rather than a fact the application may rely on. It is a
redirect convenience, not a security boundary.

### Staff are scoped by assignment, not by employment

Agency staff should not reach every client by default just because the agency
has access to everything. `users` therefore carries no meaningful tenant of its
own; scope comes from `user_tenant_assignments`, and anything outside that set
requires a row in `access_elevations` — time-boxed, attributed and revocable.

`users.tenant_id` is nullable for the same reason: every persona here is agency
staff, since clients never log in.

### Authentication reads through SECURITY DEFINER functions

Login has to read `users` before any actor or tenant is known, which RLS
otherwise forbids. Rather than loosening the policy, `app.login_lookup()` and
`app.session_lookup()` (migration 0003) expose exactly the columns those two
steps need. The table stays closed, and there is a single auditable path to a
password hash. `app_service` is denied execute on all of them.

### Secrets use envelope encryption

Each credential gets its own random data key, is encrypted with it, and the
data key is wrapped by the master key from `KMS_MASTER_KEY`. Only the wrapped
key and the ciphertext reach the database. `KMS_PREVIOUS_KEYS` keeps older
records readable through a rotation.

The secret's `purpose` is bound in as additional authenticated data, so a
HubSpot credential blob cannot be replayed into a voice-provider slot. The
interface mirrors a cloud KMS so AWS or GCP KMS can be swapped in without
touching callers.

### PII is encrypted per column, with blind indexes for lookup

Encryption has to happen at the application layer, not just at the
disk or volume level, so that a database dump alone does not expose raw phone
numbers or emails. It happens in `src/lib/crypto/pii.ts`, so values are
ciphertext before they reach PostgreSQL.

Encrypted columns cannot be searched, but the platform needs `(tenant_id,
phone)` lookups for deduplication and DNC checks. Each lead therefore stores a
**blind index** — a keyed HMAC of the normalised value — alongside the
ciphertext. It is tenant-salted, so the same phone number produces a different
index per client and one tenant's index cannot probe another's rows.

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
reaches the CRM. Requiring a second, manual consent step here was friction that
recorded nothing the funnel had not already established, and it suppressed real
leads as `no_consent` for a permission that had in fact been given.

So migrations 0006 and 0008 dropped the *gate* and kept the *record*: intake
writes a `consents` row for every lead, derived from where the lead came from,
so a call can cite the specific basis it was placed under. The row is honest
about its provenance — `captured_by = 'inherited_upstream'` says the agency did
not run the opt-in funnel and has not independently verified it.

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
Behind a platform that sets and replaces the client address headers they are;
exposed directly to the internet they are not — which is why the per-account
login rule is keyed on the email instead.

### A lead dials itself; the scheduler is a safety net

The target is p95 under 30 seconds from CRM ingestion to dial. The queue could
always deliver that — `next_call_at` is `now()` the moment intake commits — but
nothing asked it to. Something had to tick, and the only thing that did was a
scheduler running once a minute, which spends most of that budget waiting.

So the webhook that receives a lead places the call, after its own response:
`after()` in the route, `waitUntil` underneath. The CRM is acknowledged in
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
hours later, a calling window opening, a requested callback, a callback whose
time passed with no call behind it, a lead stranded by an invocation that died
mid-call, and the sync outbox clearing after an integration outage. One
endpoint for every tenant and every campaign — an idle client costs nothing,
because the pass enumerates outstanding work rather than looping over clients.

It authenticates with a shared secret rather than a service token, which is the
one privilege boundary it widens: service tokens are per tenant by design and
this crosses all of them. So it reads only enough to enumerate work, then does
the work inside per-tenant scopes, and refuses to serve at all when
`CRON_SECRET` is unset rather than defaulting to open.

`scripts/worker.ts` calls that same endpoint on a timer, so what runs locally is
what runs deployed.

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
qualification questions, and the token the CRM posts with. A half-onboarded
client is worse than none — a tenant with no campaign is invisible in most of
the UI, and a campaign whose token was never minted looks configured while the
CRM has no way to reach it.

What onboarding deliberately cannot do is make the campaign dial. It starts
inactive, on the `mock` provider, and returns `activationBlockers()` for the
operator to work through — the destination in particular is a credential
someone has to paste in, which a template cannot supply.

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

---

## Repository layout

```
db/migrations/          Authoritative SQL. Forward-only, checksummed.
  0000_roles_and_helpers.sql         Roles, RLS helper functions
  0001_core_schema.sql               Core data model, consent, PII, review
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
  0013_analytics_indexes.sql         Analytics indexes and precomputed latency
  0014_callback_worklist.sql         Callback resolution, attribution, sweep support
scripts/                migrate / seed / reset / worker / tunnel / demo
src/db/                 Pools, scoped transactions, typed schema mirror
src/lib/crypto/         KMS envelope encryption, PII, password hashing
src/lib/auth/           Sessions, RBAC, tenant middleware, service tokens
src/lib/leads/          Intake, eligibility, DNC gate, CRM events and campaign routing
src/lib/calling/        Queue, windows, retry ladder, worker, results, callbacks, dispatch
src/lib/qualification/  Schema, analysis, provider registry, scoring, review gate, resolution
src/lib/providers/      Voice adapter interface: mock, Sarvam, Twilio, per-client credentials
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
n8n/                    W01-W04 workflow definitions (optional; see n8n/README.md)
tests/unit/             No database required
tests/db/               Isolation, auth, configuration and the vertical slice, against real PostgreSQL
```

`db/migrations` is authoritative. `src/db/schema.ts` is a hand-maintained typed
mirror for query building — RLS policies, partial indexes and check constraints
have no faithful representation in it, so **do not generate DDL from it.**

Migrations are checksummed once applied; editing an applied file fails the next
run. Write a new migration instead.

### Stack

Next.js 16 (App Router, React 19) · TypeScript · PostgreSQL 17 · `pg` ·
Drizzle (schema mirror only) · Zod · Vitest · the Anthropic and Google GenAI
SDKs. No ORM in the query path, no client-side state library, no CSS framework.

---

## Testing and CI

```bash
npm run test:unit    # crypto, RBAC, phone, scoring, signatures, providers, onboarding
npm run db:up && npm run db:migrate
npm run test:db      # tenant isolation, auth, configuration, callbacks, vertical slice
```

The database tests are the ones that matter for the isolation claims above:
they assert that a scope-less connection sees nothing, that one tenant's blind
index cannot probe another's rows, and that a denied tenant is indistinguishable
from a missing one. `.github/workflows/ci.yml` runs typecheck, migrations, the
whole suite and a production build against a real PostgreSQL service.

The LLM is stubbed in tests, so the suite is deterministic and free to run.
Everything else — the queue, the locks, the RLS scope, the outbox — is the real
implementation against a real database.

---

## Deploying

[docs/DEPLOY.md](docs/DEPLOY.md) walks the whole path on Vercel with a managed
PostgreSQL, including the scheduled sweep, the environment split, and what to
check before pointing a real lead list at it.

Two things to get right wherever you host it:

- **`APP_URL` must be public and stable.** Provider callback URLs are minted
  from it, and a signature check is performed against the URL the provider
  called.
- **The three database roles are not optional.** The owner role runs
  migrations; the application must connect as `app_user` or `app_service` or
  row-level security does not apply to it.

---

## What is not done

- **A voice provider proven in production.** Three adapters exist: `mock`
  (always available, places no calls), plus `sarvam` and `twilio`. Either real
  provider can be configured per client or agency-wide, and a provider with
  neither fails loudly at claim time rather than dialling through something
  half-set-up. Neither has been run against a production account or at volume.
- **Email notifications.** Slack delivery is built — an incoming webhook per
  client, sealed like any other credential, delivered through the sync outbox
  so an outage is a retry rather than a lost hot lead. Email is not, and
  neither is per-campaign routing of who gets told.
- **Alerting.** The signals are emitted as structured log lines, but nothing
  pages anyone. Load testing, a backup/restore drill and security testing are
  also outstanding. Rate limiting, the dead-letter replay UI, structured
  logging and readiness checks are done.
- **Live transfer, multi-channel follow-up, A/B testing.**

---

## Contributing

Issues and pull requests are welcome.

- Run `npm run typecheck && npm test` before opening a PR. The database tests
  need the container up (`npm run db:up && npm run db:migrate`).
- Schema changes go in a **new** migration under `db/migrations`. Applied
  migrations are checksummed and must not be edited.
- Any new tenant-scoped table needs its RLS policy and grants in the same
  migration, and a case in `tests/db/tenant-isolation.test.ts`.
- Every write that changes configuration, suppresses a lead, or reads personal
  data should go through `tenantAction()` / `globalAction()` in
  `src/lib/actions.ts`, which makes the permission check and the audit row
  structural rather than remembered.
- Comments here explain *why*, not *what*. If a decision looks strange, the
  comment should say what it is protecting against.

---

## Security

This platform places automated phone calls and stores personal data. Whoever
deploys it is responsible for having a lawful basis for those calls in their
jurisdiction — registration, consent evidence, calling-hour restrictions and
do-not-call compliance are all deployment obligations, not features you get for
free by running this.

To report a vulnerability, open a
[security advisory](https://github.com/Abhisharma08/voice-call/security/advisories/new)
rather than a public issue.

Never commit a real credential. `.env.local` is gitignored; `.env.example`
holds placeholders and local-only development passwords.

---

## Licence

[MIT](LICENSE).
