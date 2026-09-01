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

Then press **Test connection** on the Sheets integration. It confirms access
and writes the 22-column header row if the tab is empty.

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

## 6. Voice provider — this one needs code

Only the `mock` provider is registered. It places no calls; it returns scripted
transcripts so the rest of the pipeline can be exercised.

A real provider means implementing `VoiceProvider` in
`src/lib/providers/voice/types.ts` — six methods:

```ts
metadata()            // name, capabilities, permitted regions
createCall(request)   // dial, return the provider's call id
getCallStatus(id)     // poll fallback
handleWebhook(body, headers)   // verify signature, normalise the payload
retrieveTranscript(id)
hangup(id)
```

Then register it:

```ts
registerProvider("twilio", () => new TwilioVoiceProvider(config));
```

and select it per campaign in the editor. The calling worker does not change.

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

## 7. Before any real call: the compliance gate

The platform will not dial until three things are recorded, in order. This is
deliberate and enforced by a database constraint, not just the UI.

**Campaigns → your campaign:**

1. **Consent basis for the client's lead list** (PRD 14.3 step 10) — what the
   client asserted, where it came from, and a reference to the evidence.
   Attributed to whoever records it.
2. **Compliance approval** (PRD 17.3) — Agency Admin only, and it requires
   writing what was actually reviewed: sender/telemarketer registration,
   consent evidence, provider arrangement, DNC handling, recording notices,
   retention. The attestation goes in the audit log.
3. **Activate** — refuses while any checklist item is open.

None of this substitutes for the review itself. The software's job is to refuse
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
| Integration flips to `error` and stops | PRD 18.2: auth failure disables rather than retrying. Fix the credential, press *Test connection* to re-enable |
| Call results never arrive | `APP_URL` is stale or the tunnel died |
| Campaign will not activate | Open items on the compliance checklist |
| Leads suppressed as `no_consent` | No consent basis on the campaign, and none in the event |
| Only 5 leads dialled | `concurrency_limit` on the campaign (FR-022). Working as intended |

Everything above is also visible in `/audit`, filtered by category.
