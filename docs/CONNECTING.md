# Connecting everything

Six things plug into this platform, and all six are now configuration.

| What | Effort | Blocking? |
| --- | --- | --- |
| 1. Anthropic or Gemini (qualification) | one env var | No — degrades to review queue |
| 2. Public URL (webhooks) | one command locally, your domain in production | Yes, for anything inbound |
| 3. HubSpot (CRM) | private app + one button | Yes, for leads and CRM sync |
| 4. Google Sheets (call log) | service account + share | Yes, for the sheet |
| 5. Orchestration | one env var — the platform schedules itself | Yes, for retries and callbacks |
| 6. **Voice provider (calls)** | **credentials, then pick it per campaign** | **Yes, for real calls** |

Do them in this order. Each step is verifiable before you move on, and the
checklist on the campaign page names anything still missing.

---

## 1. Transcript qualification — Anthropic or Gemini

Add a key to `.env.local` and restart the dev server:

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_WORKSPACE_ID=          # only for an identity-linked key, see below
GEMINI_API_KEY=                  # optional, registers the Gemini adapter
```

The Anthropic SDK also accepts `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login`
profile with no env var at all.

**Verify:** run `npm run demo`. Step 4 should print real intents
(`hot`, `not_interested`, `do_not_call`) rather than `unknown`.

Without a key, analysis degrades to `unknown` at confidence 0, which always
trips the review gate. That is the fallback working — nothing is
auto-qualified — but no result ever reaches a CRM either.

**If the key is an identity-linked one** (scoped to a person rather than a
workspace) it also needs `ANTHROPIC_WORKSPACE_ID`. Without it every request
fails with `anthropic-workspace-id is required` and every analysis degrades —
which is indistinguishable from having no key at all unless you read the log.

### Choosing the model

Which provider runs is decided per campaign by `campaigns.analysis_model`
(*Campaigns → your campaign → model*). The prefix selects the adapter: a
`claude-*` id resolves to Anthropic, a `gemini-*` id to Google. A model no
adapter claims, or one whose provider has no key, holds that campaign's leads
for review with a reason naming the registered providers — it never dials on
and writes a result no model produced.

Two things behave differently on Gemini, both in `providers/gemini.ts`:

- **Prompt caching is implicit.** The Interactions API has no `cache_control`
  equivalent — caching happens automatically on a shared prefix or not at all.
  The system prompt is byte-identical per campaign so it is eligible, but a
  short one can fall under the model's minimum cacheable length and never hit.
  Per-call cost is less predictable than on Anthropic.
- **Server-side retention is off.** `store` defaults to true on that API, which
  would retain transcripts — the most sensitive text here. The
  adapter sets `store: false`. Do not change that without a deliberate
  decision.

Both providers validate against the same Zod schema before anything is
persisted, so schema validation holds whichever one answers.

---

## 2. A public URL — for inbound webhooks

HubSpot and your voice provider both need to reach this app. On a laptop that
means a tunnel:

```bash
# any of these work
cloudflared tunnel --url http://localhost:3000
ngrok http 3000
```

Put the resulting HTTPS URL in `.env.local` as `APP_URL` and restart. The
calling worker builds provider callback URLs from it, so a stale value means
call results silently never arrive.

```
APP_URL=https://your-tunnel.example.com
```

**Verify:** `curl https://your-tunnel.example.com/api/health` returns
`{"status":"ok",...}` from outside your machine.

---

## 3. HubSpot

### Create a private app

1. HubSpot → Settings → Integrations → **Private Apps** → *Create*
2. Scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`,
   `crm.schemas.contacts.write` (needed to create the custom properties),
   `crm.objects.tasks.write` (for the follow-up task)
3. Copy the access token — it starts `pat-na1-`

### Store it

In the app: **Integrations → Add a credential**, type *HubSpot*, paste:

```json
{ "accessToken": "pat-na1-..." }
```

### Press "Test connection"

This does two things: confirms the token reaches your portal, and **creates
the ten custom contact properties** the CRM sync writes (`ai_intent`,
`ai_score`, `ai_do_not_call`, …) under a property group called *AI Lead
Qualification*.

That second part is not optional. HubSpot rejects a PATCH naming a property
that does not exist, so on a fresh portal every CRM sync fails with a 400 until
those properties are created. The button is idempotent — press it again
whenever you like.

### Send leads in

**If the client is on the free plan, use the private app path below.** Free
HubSpot has no workflows, so the *Send a webhook* action does not exist for
them. Private apps are available on every tier.

#### Free plan: private app subscription

A private app can subscribe to `contact.creation`, and this platform takes that
subscription directly:

```
POST $APP_URL/api/webhooks/hubspot/events
```

No token in the URL and no header to configure — which is not a shortcut, it is
a constraint. HubSpot cannot attach a credential of ours to a webhook, so it
signs each delivery instead, and the payload's `portalId` is what names the
client. Three consequences worth knowing before you set it up:

1. **The connection test is not optional.** It is what records the portal id
   (from `/account-info/v3/details`), and without that mapping an inbound event
   resolves to no client and is refused. Press *Test connection* once on
   `/integrations` after adding the credential.
2. **The credential needs the client secret as well as the access token**, or
   nothing can be verified:
   `{"accessToken": "pat-na1-...", "clientSecret": "..."}`
3. **The event carries no contact.** It names an object id, so the platform
   fetches the contact's properties back over the CRM API. Intake therefore
   depends on the access token being valid, not just the write-back — an
   expired token stops leads arriving, not merely syncing.

Setting it up in the client's HubSpot:

- *Settings → Integrations → Private apps → Create*, with the
  `crm.objects.contacts.read` and `crm.objects.contacts.write` scopes.
- Copy the **access token** and the **client secret** into a HubSpot
  integration here, then press *Test connection*.
- In the private app's **Webhooks** tab, set the target URL above and subscribe
  to `contact.creation`.

Which campaign a lead lands in comes from a contact property, configured under
*Lead routing* on the campaign — one private app has a single target URL for
the whole portal, so it cannot be a query parameter. A client with one active
campaign needs no routing at all: every lead goes there.

Rate limits are the reason to keep the subscription narrow: a free portal
allows 100 requests per 10 seconds per app, and every event costs one contact
fetch. Subscribe to `contact.creation`, not to property changes on a busy
property.

**Verify:** create a test contact in HubSpot with a phone number. `/leads`
should show it within seconds, and `/calls` an attempt right behind it. If the
lead never appears, the log says which of the three steps above is missing —
`unknown_portal` means the connection test has not run.

#### Professional and above: workflow action

**`/api/webhooks/hubspot/leads?campaign=<uuid>`** takes HubSpot's own workflow
payload, so a *Send a webhook* action can post to it with no translation layer
and no contact fetch. This is the URL **Clients → Onboard a client** shows
under "Professional or Enterprise", together with the token for the
`Authorization` header.

```bash
curl -X POST "$APP_URL/api/webhooks/hubspot/leads?campaign=<campaign uuid>" \
  -H "authorization: Bearer $SERVICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '[{"eventId":"hs-evt-123","objectId":"123456789","properties":{
        "firstname":"Rahul","lastname":"Sharma","phone":"+919876543210",
        "requirement":"12 windows, Sector 78 Noida"}}]'
```

The campaign is a query parameter because HubSpot's payload cannot carry it and
a token is per tenant, not per campaign. Property names are mapped in
`src/lib/leads/hubspot-event.ts`; unknown ones are ignored rather than
rejected, so a new field on the client's form cannot start failing intake. Set
the enquiry text deliberately — `requirement`, `product_interest`,
`what_are_you_looking_for` or `message` — because the call says it back to the
lead rather than guessing.

**Either endpoint places the call itself**, on the same invocation, after
responding. There is no scheduler to wait for and nothing else to run.

**`/api/webhooks/leads`** takes this platform's own event shape, for anything
you control:

```bash
curl -X POST "$APP_URL/api/webhooks/leads" \
  -H "authorization: Bearer $SERVICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "event_id": "hs-evt-123",
    "source": "hubspot",
    "record_id": "123456789",
    "campaign_ref": "<campaign uuid>",
    "contact": { "name": "Rahul Sharma", "phone": "+919876543210" }
  }'
```

Note what is *not* in that payload: a tenant id. The platform never trusts one
from a caller, so the platform derives it from the service token. A second
client means a second token, not an extra field.

---

## 4. Google Sheets

### Create a service account

1. Google Cloud Console → **IAM & Admin → Service Accounts** → *Create*
2. Create a **JSON key** and download it
3. Enable the **Google Sheets API** for that project

### Share the sheet with it

Open your spreadsheet → *Share* → paste the service account's
`client_email` (it looks like `something@project.iam.gserviceaccount.com`) →
**Editor**.

This is the step everyone misses. A service account is a separate principal;
an unshared file returns 404 no matter how valid the key is. The connection
test reports that case specifically rather than as a generic auth error.

### Store it

**Integrations → Add a credential**, type *Google Sheets*, paste the whole
downloaded JSON.

### Point a campaign at the sheet

**Campaigns → your campaign → Destinations**:

- **Google Sheet ID** — from the URL: `docs.google.com/spreadsheets/d/<THIS>/edit`
- **Sheet range** — `Call Log!A:Z`

Then press **Test connection** on the Sheets integration. It confirms access,
**creates the tab if it does not exist** (a new spreadsheet only has `Sheet1`),
and writes the 22-column header row if that tab is empty.

The test uses the range you configured above, not a hardcoded one - testing a
destination the sync will not actually write to proves nothing.

---

## 5. Orchestration — the platform schedules itself

**Nothing to install.** This step used to be "import four n8n workflows"; three
of the four were a timer and a payload reshape, and both now live in the
platform:

| Was | Now |
| --- | --- |
| W01 — reshape HubSpot's payload | `/api/webhooks/hubspot/leads`, typechecked and tested |
| W02 — dial every minute | the intake webhook dials on its own invocation |
| W03 — notice a completed call, then analyse | the voice callback qualifies inline |
| W04 — sweep retries and callbacks every 5 minutes | `/api/cron/tick` |

The reason this collapsed so cleanly is that n8n never held any state:
the queue, locks, retry ladder, idempotency keys and outbox are all PostgreSQL
rows. A workflow engine was scheduling work it did not own, and a schedule is a
cron.

Set `CRON_SECRET` and point a scheduler at the sweep:

```bash
curl -X POST "$APP_URL/api/cron/tick" -H "authorization: Bearer $CRON_SECRET"
```

On Vercel, `vercel.json` already declares it and the platform sends that header
itself — see [`DEPLOY.md`](DEPLOY.md). Locally, `npm run worker` calls the same
endpoint on a timer.

The `n8n/` directory is kept for reference and for anyone who wants a workflow
engine in front of intake. It is no longer part of the running system.

### Getting a service token

**Clients → Onboard a client** mints one and shows it beside the webhook URL to
use it with. Tokens are stored only as a SHA-256 hash, so the plaintext appears
once — a lost token is replaced, not recovered.

For the development fixtures, `npm run db:seed:phase1` prints one.

---

## 6. Voice provider

Three adapters exist: `mock` (places no calls, returns scripted transcripts),
`sarvam`, and `twilio`.

### Where a provider's credentials come from

Two sources, and the first one that has a credential wins:

| Source | Scope | Set up in |
| --- | --- | --- |
| **The client's own credential** | One client | Integrations → Add a credential → Voice provider |
| **The agency's account** | Every client | `.env.local` / deployment environment |

A client with their own Sarvam workspace or Twilio account is dialled through
it — billed to their account, calling from their number. A client without one
falls back to the agency's. Neither is more "correct": one shared account
across every client is an ordinary arrangement and needs no rows at all.

In the UI the credential is entered as fields rather than pasted as JSON:
choose the provider and fill in what its console gives you. It is sealed with a
per-secret data key before it reaches the database and is never read back —
the page shows a status, never a secret. To rotate one, use **Replace
credential**; the integration keeps its id, so every campaign pointing at it
follows the new credential.

Two values are always environment-level, whichever path you take:
`VOICE_WEBHOOK_SECRET` (it keys a token this platform mints and verifies
itself) and `APP_URL` (where the provider has to reach this process). Neither
is a property of a client's account, and a per-client value for either is a
per-client way to break inbound callbacks.

The **Voice providers** panel on the Integrations page says, per provider,
whether this client is selectable at all and whether it is on their own
credential or the agency's. The campaign's **Voice provider** dropdown lists
exactly what that client can actually dial with.

### Sarvam AI

Two ways in. They do the same thing; pick by who owns the account.

**Per client, in the UI** — **Integrations → Add a credential → Voice
provider → Sarvam AI**, then seven fields: API key, organisation, workspace,
app, app version (optional, defaults to 1), connection, and agent phone number.
The number must be E.164; the form refuses anything else rather than letting
the carrier reject it at dial time.

**Test connection** then proves the API key, organisation, workspace and app id
against Sarvam's analytics endpoint without placing a call. It reports the
connection id and agent number as *untested*, because nothing but a real call
exercises those — a green tick that implied otherwise would be worse than no
check at all.

**Agency-wide, in the environment** — set these in `.env.local` and restart.
The adapter registers only when all six are present, so a half-configured
provider fails at claim time with a clear message rather than dialling.

```
SARVAM_API_KEY=
SARVAM_ORG_ID=
SARVAM_WORKSPACE_ID=
SARVAM_APP_ID=
SARVAM_APP_VERSION=1
SARVAM_CONNECTION_ID=
SARVAM_AGENT_PHONE_NUMBER=+91...
VOICE_WEBHOOK_SECRET=<a long random string>
```

From the Sarvam console: the org and workspace your agent lives in, the agent
("app") that runs the conversation, and the telephony connection plus the
number calls originate from. Then set **Voice provider → `sarvam`** on the
campaign.

One Sarvam agent serves every campaign. The script, business context and
qualification questions travel as `agent_variables` and
`app_overrides.initial_bot_message` on each call, so campaign differences stay
configuration here too.

**Callback URL** — point the agent's webhook at
`https://<your APP_URL>/api/webhooks/voice/sarvam`. The adapter builds this
from `APP_URL`, so a stale value means results never arrive.

#### Two things worth knowing

**Sarvam does not sign its webhooks.** There is no signature header to verify.
The adapter works around it: `createCall` puts a keyed token in
`webhook_config.metadata`, which Sarvam echoes back untouched, and the callback
handler recomputes it from the call id. That authenticates the *call* rather
than the payload, so treat it as defence in depth — the endpoint still requires
a bearer service token, and `recordCallResult` is idempotent on
(provider, provider_call_id). Put the callback behind a source-IP allowlist in
production if Sarvam publishes one.

**NDNC failures are suppressions, not retries.** Sarvam surfaces the carrier
message verbatim, e.g. `"exotel: Phone number is registered under TRAI NDNC"`.
The adapter recognises NDNC/DND registrations and dead numbers and returns a
`suppress` signal; the platform then adds the number to the tenant DNC list and
stops all future attempts. Without that, the retry ladder would re-dial a
number the registry says must not be called.

`hangup()` throws: Sarvam documents no cancel endpoint, and a silent no-op
would let a caller believe a call in progress had been stopped. Suppression
still applies to every future attempt.

### Twilio (local testing)

Telephony only — Twilio dials and plays audio; the conversation is TwiML this
platform serves. Enough to exercise the whole pipeline against a phone that
actually rings, and no substitute for a production voice agent.

```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...
APP_URL=https://your-tunnel.example.com    # Twilio must reach this
VOICE_WEBHOOK_SECRET=<long random string>
```

Registers when the first three are set. Then **Voice provider → `twilio`** on
the campaign. No callback URL to configure in the Twilio console — the adapter
passes `Url` and `StatusCallback` on each call.

**How the conversation works.** `createCall` points Twilio at
`/api/webhooks/voice/twilio/twiml`. That endpoint speaks the opening script and
the first question, `<Gather input="speech">` captures the answer, and the next
request asks the next question. Each turn is appended to the call's transcript,
so by the time the status callback reports `completed` there is a real
conversation for qualification to read.

It is deliberately simple: no barge-in, no clarification, no recovery from a
misheard answer. It reads a question, waits, moves on.

**Authentication.** Twilio signs with `X-Twilio-Signature` — HMAC-SHA1 over the
full request URL plus every POST parameter sorted by name. Both endpoints
verify it. A carrier cannot attach a bearer service token to a status callback,
so for Twilio the signature *is* the credential and the tenant is resolved from
the call record the SID names. The TwiML endpoint additionally checks a
call-bound token in the URL, so it cannot be driven for an arbitrary call.

**India.** Twilio's guidance restricts outbound calls to Indian non-Twilio
numbers to non-Indian originating numbers. That applies to any
stack where Twilio is the carrier — **including ElevenLabs**, which brings no
numbers of its own. It is the reason Sarvam is the production option here.

### ElevenLabs

ElevenLabs Agents is a voice-AI layer, not a carrier: you bring a Twilio number
or a SIP trunk. So a Twilio account is needed either way, and the number set up
for local testing carries forward.

No adapter yet. Their outbound call surface would slot in as a sixth
`VoiceProvider` implementation the same way Sarvam did.

### Testing with a free trial account

Every provider's free trial restricts outbound calls to **numbers you have
verified on the account**. Twilio states it plainly: "Outbound trial calls can
only be placed to a validated phone number", with a 10-minute cap and a trial
notice played before the call connects. Sarvam requires KYC before a number can
be rented at all.

So a trial answers exactly one question — *does my phone actually ring, and does
the transcript come back* — and cannot be used to call a real lead list.

| Provider | Gives you a number? | Trial | India outbound |
| --- | --- | --- | --- |
| Sarvam | Yes, after KYC | No documented trial tier | Native — Indian carriers |
| Twilio | Yes | Free credit, verified numbers only | Restricted: Indian non-Twilio numbers need a non-Indian originating number |
| ElevenLabs | **No** — bring Twilio or SIP | n/a | Inherits whatever the underlying carrier allows |
| Plivo / Telnyx / Vonage | Yes | Free credit, verified numbers only | Varies; check per-country rules |

Since the constraint is real, the platform mirrors it. Set **Dial allowlist**
on the campaign to the E.164 numbers verified on your trial account:

```
+919876543210
```

While it is non-empty, every other lead is suppressed as
`not_on_dial_allowlist` **before a call is placed**. Without that, a trial
account pointed at a real list fails at the carrier on every number, consuming
one attempt from each lead's retry budget and filling the queue with opaque
provider errors — and a half-configured staging environment can dial real
people.

The campaign list shows an `allowlist: N numbers` badge while it is set. Clear
it before going live.

**A trial is not the cheapest way to test the pipeline.** The `mock` provider
already exercises intake, queue, retries, DNC, qualification, review and sync
end-to-end at no cost — `npm run demo`. Reach for a trial only when you want to
confirm the audio path itself.

### Writing another adapter

Implement `VoiceProvider` in `src/lib/providers/voice/types.ts` — six methods:

```ts
metadata()            // name, capabilities, permitted regions
createCall(request)   // dial, return the provider's call id
getCallStatus(id)     // poll fallback
handleWebhook(body, headers)   // verify signature, normalise the payload
retrieveTranscript(id)
hangup(id)
```

Then register it in `src/lib/providers/voice/index.ts`:

```ts
registerProvider("twilio", () => new TwilioVoiceProvider(config));
```

and select it per campaign in the editor. The calling worker does not change.

Provider credentials currently come from environment variables, so one Sarvam
account serves all tenants. Per-tenant provider credentials are a Phase 3 item
— the `integrations` table already has a `voice_provider` type for it.

### Before you pick one

Provider selection here is not only a technology preference.
Twilio's current India guidance says outbound calls to Indian non-Twilio
numbers can only originate from non-Indian numbers, and recommends legal
review [Ref. 7]. TRAI's TCCCPR rules govern registered headers and consent for
commercial voice calls [Refs. 4–6].

The reading here is that **the agency**, not the client, is the party
initiating commercial communication — so the agency's own sender/telemarketer
registration is what is engaged. Confirm that with telecom counsel before
picking a provider, because the answer changes which providers are viable.

---

## 7. Consent

Consent is collected upstream — the landing page or Meta lead form — and the
lead reaches HubSpot before this platform sees it. So the platform **records**
consent rather than demanding it.

On intake every lead gets a dated `consents` row, derived in this order:

1. Consent that arrived with the event. W01 maps HubSpot's fields
   (`consent_basis`, `hs_legal_basis`, `hs_latest_source`) through when set.
2. A basis explicitly declared on the campaign, if a Campaign Manager recorded
   one.
3. The campaign's consent origin, or the lead's source — written as
   `captured_by = inherited_upstream`.

That last label is deliberate: it says the agency did not run the opt-in funnel
and has not independently verified it, which is a truer record than a blanket
assertion and is what makes a call individually justifiable later.

**Nothing blocks.** Naming the origin on the campaign (*Consent basis → Record
origin*) is optional and only makes the audit trail easier to read.

Two things still stop a call:

- **A withdrawal.** If a lead's consent is marked withdrawn, they are not
  called. Someone unsubscribing after the form is the case the record exists
  for, and it is a different permission from the one the form collected.
- **DNC.** Manual, voice-detected, or carrier-reported (see the NDNC note in
  step 6).

For a list whose provenance is *not* established upstream — a purchased list,
or a client import with no funnel behind it — this platform has no gate to
switch on, and never usefully had one: the missing-record check it used to run
only ever fired on leads the funnel had already collected consent from. Whether
such a list may be called at all is a judgement about the list, made before it
reaches this platform. Nothing here will make it for you.

## 8. Before any real call

**Campaigns → your campaign:**

1. Work through anything the checklist still names: an opening script,
   qualification questions, and a Google Sheet or HubSpot destination.
2. Keep your own number in the dial allowlist for the first live call — while
   that list is non-empty every other lead is suppressed before a call is
   placed.
3. **Start calling.**

---

## Verifying the whole chain

With everything connected:

```bash
npm run demo
```

Then check, in order:

| Where | Expect |
| --- | --- |
| `/leads` | Nine leads: queued, quarantined, suppressed |
| `/calls` | Attempts with consent basis and config version per row |
| `/review` | Low-confidence results held back |
| Your HubSpot contact | `ai_intent`, `ai_score`, `ai_call_summary` populated |
| Your Google Sheet | One row per committed call, phone **masked** |
| `/audit` | The whole journey, including who revealed a phone number |

The phone number is masked in the sheet on purpose. Once data leaves
PostgreSQL, it is outside the platform's access-control layer.

---

## When something does not work

| Symptom | Cause |
| --- | --- |
| Every result says `unknown`, confidence 0 | No Anthropic credentials (step 1) — or a key that is set but rejected, which looks identical. Check the dev server log for a 400: an identity-linked key needs `ANTHROPIC_WORKSPACE_ID` set as well |
| HubSpot sync 400s | Custom properties missing — press *Test connection* |
| Sheets sync 404s | Spreadsheet not shared with the service account |
| `Unable to parse range: Call Log!A1:V1` | Was a bug in this platform, fixed. A tab name with a space must be quoted in A1 notation (`'Call Log'!A1:V1`); the client now quotes it, and creates the tab if it does not exist |
| Integration flips to `error` and stops | Auth failure disables rather than retrying. Fix the credential, press *Test connection* to re-enable |
| Call results never arrive | `APP_URL` is stale or the tunnel died |
| Campaign will not start calling | Open items on the checklist |
| Leads suppressed as `no_consent` | Gone as of migration 0008. Leads the old gate stranded were re-queued by it; if you still see this, the migration has not been applied |
| Leads suppressed as `consent_withdrawn` | A `consents` row for that lead is marked withdrawn — an opt-out after the form. Working as intended |
| Leads suppressed as `not_on_dial_allowlist` | The campaign has a dial allowlist set, for a trial provider account. Clear it to go live |
| Trial call connects but cuts off | Twilio trial calls are capped at 10 minutes |
| Only 5 leads dialled | `concurrency_limit` on the campaign. Working as intended |
| `Unknown voice provider "sarvam"` | Not all six `SARVAM_*` vars are set, or the server was not restarted |
| `Unknown voice provider "twilio"` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` or `TWILIO_FROM_NUMBER` missing, or no restart |
| Twilio: "the destination number is not verified" | Trial account. Verify the number in the Twilio console and add it to the dial allowlist |
| Twilio call rings but the transcript is empty | `APP_URL` is not publicly reachable, so Twilio could not fetch the TwiML |
| Twilio status callbacks rejected as invalid signature | `APP_URL` does not match the URL Twilio actually called — the signature covers the URL |
| Sarvam call results never arrive | `APP_URL` stale, or the agent's webhook is not pointed at `/api/webhooks/voice/sarvam` |
| Lead suppressed as `trai_ndnc_registered` | The number is on India's NDNC registry. Correct and permanent |

Everything above is also visible in `/audit`, filtered by category.
