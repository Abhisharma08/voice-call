# Connecting everything

Six things plug into this platform. Five are configuration; one needs code
that does not exist yet.

| What | Effort | Blocking? |
| --- | --- | --- |
| 1. Anthropic (qualification) | one env var | No — degrades to review queue |
| 2. Public URL (webhooks) | one command | Yes, for anything inbound |
| 3. HubSpot (CRM) | private app + one button | Yes, for CRM sync |
| 4. Google Sheets (call log) | service account + share | Yes, for the sheet |
| 5. n8n (orchestration) | import 4 workflows | No — the API works without it |
| 6. **Voice provider (calls)** | **write an adapter** | **Yes, for real calls** |

Do them in this order. Each step is verifiable before you move on, and the
compliance gate at the end refuses to let you skip the one that matters.

---

## 1. Anthropic — transcript qualification

Add the key to `.env.local` and restart the dev server:

```
ANTHROPIC_API_KEY=sk-ant-...
```

The SDK also accepts `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile
with no env var at all.

**Verify:** run `npm run demo`. Step 4 should print real intents
(`hot`, `not_interested`, `do_not_call`) rather than `unknown`.

Without a key, analysis degrades to `unknown` at confidence 0, which always
trips the review gate. That is PRD 18.2's fallback working — nothing is
auto-qualified — but no result ever reaches a CRM either.

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
   `crm.objects.tasks.write` (for the FR-043 follow-up task)
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

Point a HubSpot workflow or webhook at your n8n W01 production URL (step 5), or
POST directly:

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

Note what is *not* in that payload: a tenant id. PRD 8.2 forbids trusting one
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
- **Sheet range** — `Call Log!A:V`

Then press **Test connection** on the Sheets integration. It confirms access,
**creates the tab if it does not exist** (a new spreadsheet only has `Sheet1`),
and writes the 22-column header row if that tab is empty.

The test uses the range you configured above, not a hardcoded one - testing a
destination the sync will not actually write to proves nothing.

---

## 5. n8n

Import the four workflows from `n8n/`:

| File | Trigger | Does |
| --- | --- | --- |
| `W01-lead-intake.json` | HubSpot webhook | Normalises and posts to intake |
| `W02-calling-worker.json` | every minute | Claims queued leads and dials |
| `W03-qualification.json` | call completed | Analyses, then drains the outbox |
| `W04-retry-callback.json` | every 5 minutes | Sweeps due retries and callbacks |

Then:

1. **Credential** — an n8n *Header Auth* credential named
   `Lead Platform Service Token`, with name `Authorization` and value
   `Bearer svc_...`
2. **Variables** — `PLATFORM_URL` (your public URL) and `CAMPAIGN_ID`
3. **Publish** each workflow. n8n production webhook URLs only work on a
   published workflow [Ref. 1]

### Getting a service token

Tokens are stored only as a SHA-256 hash, so the plaintext is shown once. The
Phase 1 seed prints one; to mint another:

```bash
npm run db:seed:phase1   # prints a fresh token, dev only
```

n8n holds no state. The queue, locks, retry ladder, idempotency keys and
outbox all live in PostgreSQL, so a workflow can be re-run, duplicated, or fail
halfway without double-calling a lead.

**You do not need n8n to test.** The four endpoints it calls work directly —
`npm run demo` drives the whole pipeline through them.

---

## 6. Voice provider

Two are registered: `mock` (places no calls, returns scripted transcripts) and
`sarvam`.

### Sarvam AI

Set these in `.env.local` and restart. The adapter registers only when all six
are present, so a half-configured provider fails at claim time with a clear
message rather than dialling.

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
numbers to non-Indian originating numbers [PRD Ref. 7]. That applies to any
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
| Twilio | Yes | Free credit, verified numbers only | Restricted: Indian non-Twilio numbers need a non-Indian originating number [PRD Ref. 7] |
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

### Before you pick one, read PRD 17.3

Provider selection here is a compliance decision, not a technology preference.
Twilio's current India guidance says outbound calls to Indian non-Twilio
numbers can only originate from non-Indian numbers, and recommends legal
review [Ref. 7]. TRAI's TCCCPR rules govern registered headers and consent for
commercial voice calls [Refs. 4–6].

The PRD's reading is that **the agency**, not the client, is the party
initiating commercial communication — so the agency's own sender/telemarketer
registration is what is engaged. Confirm that with telecom counsel before
picking a provider, because the answer changes which providers are viable.

---

## 7. Consent

Consent is collected upstream — the landing page or Meta lead form — and the
lead reaches HubSpot before this platform sees it. So the platform **records**
consent rather than demanding it.

New campaigns default to `inherit_from_source`. On intake every lead still gets
a dated `consents` row, derived in this order:

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
  called — under either mode. Someone unsubscribing after the form is the case
  the record exists for.
- **DNC.** Manual, voice-detected, or carrier-reported (see the NDNC note in
  step 6).

Set a campaign to `require_record` only for a list whose provenance is not
established upstream — a purchased list, or a client import with no funnel
behind it. Then a lead without an explicit consent record is suppressed.

## 8. Before any real call: the compliance gate

**Campaigns → your campaign:**

1. **Compliance approval** (PRD 17.3) — Agency Admin only, and it requires
   writing what was actually reviewed: sender/telemarketer registration,
   consent evidence, provider arrangement, DNC handling, recording notices,
   retention. The attestation goes in the audit log.
2. **Activate** — refuses while any checklist item is open.

This does not substitute for the review itself. The software's job is to refuse
to dial without it and to keep a record of who said it happened.

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

The phone number is masked in the sheet on purpose. PRD 26.2: once data leaves
PostgreSQL, it is outside the platform's access-control layer.

---

## When something does not work

| Symptom | Cause |
| --- | --- |
| Every result says `unknown`, confidence 0 | No Anthropic credentials (step 1) |
| HubSpot sync 400s | Custom properties missing — press *Test connection* |
| Sheets sync 404s | Spreadsheet not shared with the service account |
| `Unable to parse range: Call Log!A1:V1` | Was a bug in this platform, fixed. A tab name with a space must be quoted in A1 notation (`'Call Log'!A1:V1`); the client now quotes it, and creates the tab if it does not exist |
| Integration flips to `error` and stops | PRD 18.2: auth failure disables rather than retrying. Fix the credential, press *Test connection* to re-enable |
| Call results never arrive | `APP_URL` is stale or the tunnel died |
| Campaign will not activate | Open items on the compliance checklist |
| Leads suppressed as `no_consent` | The campaign is set to `require_record` and no basis is declared. Switch it to `inherit_from_source` if consent comes from the funnel |
| Leads suppressed as `consent_withdrawn` | A `consents` row for that lead is marked withdrawn. Correct under either mode |
| Leads suppressed as `not_on_dial_allowlist` | The campaign has a dial allowlist set, for a trial provider account. Clear it to go live |
| Trial call connects but cuts off | Twilio trial calls are capped at 10 minutes |
| Only 5 leads dialled | `concurrency_limit` on the campaign (FR-022). Working as intended |
| `Unknown voice provider "sarvam"` | Not all six `SARVAM_*` vars are set, or the server was not restarted |
| `Unknown voice provider "twilio"` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` or `TWILIO_FROM_NUMBER` missing, or no restart |
| Twilio: "the destination number is not verified" | Trial account. Verify the number in the Twilio console and add it to the dial allowlist |
| Twilio call rings but the transcript is empty | `APP_URL` is not publicly reachable, so Twilio could not fetch the TwiML |
| Twilio status callbacks rejected as invalid signature | `APP_URL` does not match the URL Twilio actually called — the signature covers the URL |
| Sarvam call results never arrive | `APP_URL` stale, or the agent's webhook is not pointed at `/api/webhooks/voice/sarvam` |
| Lead suppressed as `trai_ndnc_registered` | The number is on India's NDNC registry. Correct and permanent |

Everything above is also visible in `/audit`, filtered by category.
