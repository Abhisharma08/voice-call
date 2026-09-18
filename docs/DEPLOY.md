# Deploying to Vercel with managed PostgreSQL

Everything below is done once per environment. The order matters: the database
has to exist before the app can boot, and `APP_URL` has to be final before a
single call is placed — the calling worker mints provider callback URLs from
it, and Twilio's signature check compares against it.

| Step | What it gives you |
| --- | --- |
| 1. Database | Three connection strings, three privilege levels |
| 2. Migrations | Schema, RLS policies, the two runtime roles |
| 3. Environment | Keys, credentials, `APP_URL`, `CRON_SECRET` |
| 4. Deploy | The app |
| 5. Scheduler | Retries, callbacks and outbox delivery |
| 6. First admin | A way to sign in |
| 7. Client | HubSpot posting leads that dial themselves |

---

## 1. The database

Neon or Supabase both work. What the platform needs from either is unusual
enough to be worth stating: **three roles, not one.**

- the **owner** runs migrations and owns the tables
- **`app_user`** serves authenticated staff requests
- **`app_service`** serves webhooks, the scheduler and background work

Row-level security is only enforced against a non-owner role, so an app
connecting as the owner has no tenant isolation at all — `FORCE ROW LEVEL
SECURITY` in migration 0002 closes that loophole, and `env()` refuses to boot
if `DATABASE_URL_APP` equals `DATABASE_URL` outside development. Two roles
rather than one keeps the service identity away from staff accounts and
sessions (PRD 4).

Create the project, then collect **two hostnames**:

- the **direct** host, for migrations
- the **pooled** host — Neon's `-pooler` subdomain, Supabase's port `6543` —
  for everything the app does

Serverless multiplies connections: every warm instance holds its own pool. The
pooled endpoint is what keeps a traffic spike from exhausting the database's
connection slots, which fails as "cannot connect" across the whole app rather
than as backpressure on the one route that spiked. Keep `DB_POOL_MAX` small
(the default outside development is 3).

Transaction-mode pooling is fine here. Tenant scope travels in
`set_config(..., true)`, which is transaction-local, so a pooled connection
cannot carry one request's tenant into the next — that is the same property
that makes the pooler safe and the isolation sound.

### Give the runtime roles real passwords

Migration 0000 creates `app_user` and `app_service` with development passwords
if they do not exist, because CI needs them to. Replace them immediately:

```sql
-- as the owner, once, before the app is deployed
alter role app_user    password '<generated>';
alter role app_service password '<generated>';
```

If your provider does not permit `CREATE ROLE` (some managed tiers do not),
create the two roles by hand first with the names above; the migration will
then leave them alone.

## 2. Migrations

Migrations run against the **direct** connection as the owner, and are not part
of the build — a build that migrates would migrate once per preview deployment.

```bash
DATABASE_URL='postgresql://<owner>@<direct-host>/<db>?sslmode=require' \
  npm run db:migrate
```

Forward-only and checksummed: an applied file that changes fails the next run.
Write a new migration instead.

Run this before every deploy that includes a new migration file, and treat it
as part of the deploy rather than something to remember afterwards. `npm run
db:migrate` is idempotent — it prints `Database already up to date.` when there
is nothing to do — so a CI step that always runs it is safe.

## 3. Environment variables

Set these in Vercel for **production** (and again for preview, if you use it,
pointing at a separate database — PRD 17.1 wants environments to hold separate
credentials).

Generate the four key values once and keep them safe; losing
`PII_ENCRYPTION_KEY` or `KMS_MASTER_KEY` makes existing rows unreadable.

```bash
node -e 'const c=require("crypto");for(const k of ["KMS_MASTER_KEY","PII_ENCRYPTION_KEY","PII_BLIND_INDEX_KEY","SESSION_SECRET"])console.log(k+"="+c.randomBytes(32).toString("base64"))'
node -e 'console.log("CRON_SECRET="+require("crypto").randomBytes(32).toString("base64url"))'
```

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_ENV` | `production` |
| `APP_URL` | `https://your-domain` — the final one, no trailing slash |
| `DATABASE_URL` | owner, **direct** host. Only migrations use it |
| `DATABASE_URL_APP` | `app_user`, **pooled** host |
| `DATABASE_URL_SERVICE` | `app_service`, **pooled** host |
| `DB_POOL_MAX` | leave unset (defaults to 3) unless you have measured otherwise |
| `KMS_MASTER_KEY`, `KMS_MASTER_KEY_ID` | secrets vault master key, and its id |
| `KMS_PREVIOUS_KEYS` | `{}` until you rotate |
| `PII_ENCRYPTION_KEY`, `PII_BLIND_INDEX_KEY` | column encryption, blind index |
| `SESSION_SECRET`, `SESSION_TTL_HOURS` | sessions |
| `CRON_SECRET` | the scheduler's shared secret |
| `VOICE_WEBHOOK_SECRET` | keys provider callback tokens |
| `ANTHROPIC_API_KEY` | transcript qualification |
| `GEMINI_API_KEY` | optional second analysis provider |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | telephony |
| `SARVAM_*` | when you move to Sarvam; see below |

All four key values must differ from each other — `env()` refuses to start if
any two match, because reusing one key across the secrets vault, PII columns
and the blind index collapses three trust boundaries into one.

`APP_URL` deserves a second look before you move on. HubSpot and Twilio both
sign the **full URL they called**, and both signature checks compare against
this value — so a stale or trailing-slashed `APP_URL` rejects every inbound
delivery as an invalid signature, which reads as a credential problem and is
not one.

`env()` also refuses to start in production without `CRON_SECRET`. That is
deliberate: on a serverless platform nothing else dials a lead whose retry or
callback fell due, and a deployment silently missing its scheduler looks
exactly like one where nobody is calling anyone back.

## 4. Deploy

Connect the repository to Vercel, or `vercel --prod`. No adapter or custom
build settings are needed. `/api/health` reports database reachability:

```bash
curl https://your-domain/api/health
# {"status":"ok","database":"reachable","latency_ms":12}
```

## 5. The scheduler

`vercel.json` declares one cron:

```json
{ "crons": [{ "path": "/api/cron/tick", "schedule": "* * * * *" }] }
```

Vercel sends `Authorization: Bearer $CRON_SECRET` automatically. The endpoint
returns 401 without it and 503 if `CRON_SECRET` is unset — it never runs open.

**Per-minute crons need a Pro plan.** On Hobby, Vercel schedules a cron at most
once a day, which is useless here. Either upgrade, or point any external
scheduler at the same endpoint:

```bash
curl -X POST https://your-domain/api/cron/tick \
  -H "authorization: Bearer $CRON_SECRET"
```

A GitHub Actions `schedule` (5-minute floor), cron-job.org, or an uptime
pinger all work. Every minute is the useful cadence; five is tolerable. What
the sweep covers:

- retries on the backoff ladder, which come due minutes or hours later
- leads queued outside the calling window, released when it opens
- callbacks a lead asked for at a specific time
- leads stranded by an invocation that died mid-call, reclaimed on lock expiry
- the sync outbox, so a HubSpot or Sheets outage clears itself

What it is **not** responsible for is the first call to a new lead. That
happens on the webhook invocation itself, so the sweep interval does not set
your response time — see *How a lead becomes a call* below.

`scripts/worker.ts` is the local equivalent of this endpoint and is not used in
production; there is no long-lived process to run it in.

## 6. The first admin

There is no signup — clients never log in, and staff accounts are created by an
Agency Admin (PRD 14.3). Seed the first one against the production database
from your own machine:

```bash
DATABASE_URL='<owner, direct host>' APP_ENV=development npm run db:seed
```

`scripts/seed.ts` refuses to run with `APP_ENV=production`, which is why the
override is explicit above. It creates the four `*@agency.test` fixture logins
with a known password, so treat this as a bootstrap step, not a deploy step:
sign in as `admin@agency.test`, create your real staff accounts in
`/settings`, then delete the fixtures.

## 7. Onboard the client

In the app: **Clients → Onboard a client**. One form creates the client, its
first campaign from a template (script, qualification questions, scoring
rubric), and the service token HubSpot posts with. The token is displayed once
— only its hash is stored.

You get back a URL of the form:

```
https://your-domain/api/webhooks/hubspot/leads?campaign=<campaign-id>
```

### In the client's HubSpot — free plan

Free HubSpot has **no workflows**, so the *Send a webhook* action is not
available. Use a private app, which every tier can create:

1. *Settings → Integrations → Private apps → Create*, scopes
   `crm.objects.contacts.read` and `crm.objects.contacts.write`.
2. Copy the **access token** and the **client secret** into a HubSpot
   integration on `/integrations`:
   `{"accessToken": "pat-na1-...", "clientSecret": "..."}`
3. Press **Test connection**. This records the portal id, and an inbound event
   cannot find the client without it.
4. In the private app's **Webhooks** tab, set the target URL to
   `https://your-domain/api/webhooks/hubspot/events` and subscribe to
   `contact.creation`.

The delivery is authenticated by `X-HubSpot-Signature-v3` over the private
app's client secret, with a five-minute freshness window, and the tenant comes
from the `portalId` in the payload. Two operational consequences:

- **`APP_URL` is part of the signed material.** The signature covers the full
  URL HubSpot called, so a wrong or stale `APP_URL` rejects every delivery as
  an invalid signature — which looks like a bad secret and is not one. This is
  the same trap as Twilio's callbacks, for the same reason.
- **Intake depends on the access token, not just CRM write-back.** The webhook
  carries no contact properties, so an expired token stops leads *arriving*.

Which campaign a lead lands in is read from a contact property, set under *Lead
routing* on the campaign. A client with a single active campaign needs no
routing configured.

### If a client is on Professional or Enterprise

A plan with workflows can post the contact directly, with no fetch:
**Contact enrolled → Send a webhook**, `POST` to
`/api/webhooks/hubspot/leads?campaign=<uuid>`, with an
`Authorization: Bearer svc_...` header. Confirm that plan allows a custom
header on the webhook action before relying on it. Do not fall back to putting
the token in the query string: it lands in access logs and browser history.

The payload needs whatever the model should hear. `src/lib/leads/hubspot-event.ts`
maps HubSpot's property names, and the one worth setting deliberately is the
enquiry text — `requirement`, or `product_interest`,
`what_are_you_looking_for`, or `message` — because the call says it back to the
lead rather than guessing. Unknown properties are ignored rather than rejected,
so a new field on the client's form cannot start failing intake.

### Before it can dial

The campaign is created inactive on the `mock` provider, and
`/campaigns/[id]` names what is outstanding:

1. **A Google Sheet id** or a **HubSpot integration** for the call log and CRM
   write-back. Either one on its own is enough.
2. **A real voice provider** — `twilio` or `sarvam`. `/integrations` shows which
   are selectable and names the environment variables missing from the rest.
3. **Keep your own number in the dial allowlist** for the first live call.
   While that list is non-empty every other lead is suppressed before a call is
   placed. Clear it only when the client goes live.
4. **Turn calling on.**

## Rate limiting depends on your proxy

The pre-authentication endpoints — login and the webhooks — are rate limited
per source address (migration 0011), and every address comes from a request
header. Those headers are only trustworthy because Vercel sets them and
replaces whatever the client sent.

If you ever put something else in front of this app, or expose it directly, it
must overwrite `x-forwarded-for` rather than pass it through. Otherwise an
attacker rotating that header gets a fresh budget per value and the per-address
limits stop binding. The per-account login limit is keyed on the email address
instead, so the ceiling on guessing at a *specific* account survives either
way.

Nothing needs configuring for this on Vercel. It is here because it is the kind
of assumption that is invisible until the deployment shape changes.

## How a lead becomes a call

```
HubSpot private app  (free plan)        HubSpot workflow  (Pro+)
    │  contact.creation, signed             │  POST …/leads?campaign=…
    │  POST /api/webhooks/hubspot/events    │
    ▼                                       │
verify signature → portalId → tenant        │
fetch the contact's properties              │
route to a campaign by property             │
    └───────────────────┬───────────────────┘
                        ▼
intake            normalise → dedupe → consent → DNC/eligibility → queued
    │  202 returned here, in milliseconds
    ▼
after()           dial tick on the same invocation: claim, place the call
    ▼
Twilio            fetches TwiML per turn; each answer appended to the transcript
    │  POST /api/webhooks/voice/twilio   (signature-verified)
    ▼
qualification     runs inline the moment the call completes
    ▼
review gate       low confidence or a boundary score is held for a human
    ▼
outbox            Sheets, HubSpot, hot-lead routing — drained by the scheduler
```

Two properties of that diagram are worth keeping in mind when changing it.

The response is sent before the call is placed, so HubSpot is never waiting on
a carrier. And nothing in the chain depends on the `after()` step having run:
the lead is durably `queued` before the response goes out, so if the platform
drops post-response work, the next sweep places the same call. That is the
property that lets intake dial optimistically instead of carefully.

## Moving to Sarvam

Twilio is a carrier, not a voice agent. The conversation is TwiML this platform
serves — one question per turn, `<Say>` then `<Gather input="speech">`, no
barge-in and no recovery from a misheard answer. It produces a real transcript
from a real call, and it sounds like a robot.

Sarvam runs the conversation itself. The adapter is written and tested; it
registers when all six variables are set:

```
SARVAM_API_KEY  SARVAM_ORG_ID  SARVAM_WORKSPACE_ID
SARVAM_APP_ID   SARVAM_CONNECTION_ID  SARVAM_AGENT_PHONE_NUMBER
SARVAM_APP_VERSION=1
```

Then set the campaign's voice provider to `sarvam`. That is the whole switch —
per campaign, so one client can move while another stays. `/integrations`
confirms it registered; until it does, a campaign naming it holds its leads
rather than dialling through something half-configured.

One asymmetry to know about: Sarvam does not sign its callbacks, so its adapter
also requires a service token on the webhook, keyed through the per-call
metadata it carries. Twilio signs, so its callbacks authenticate themselves —
which they must, since a carrier cannot hold our credentials.

## Provider choice is not only a performance question

Twilio's own India guidance constrains this: outbound calls to Indian
non-Twilio numbers must originate from a non-Indian number, and that applies to
any stack where Twilio is the carrier. The dial allowlist is what keeps a
misconfigured provider from reaching a real lead while you find out.
