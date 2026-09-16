# n8n workflows

> **Not in use.** These are kept for the multi-client case, where per-portal
> field mappings are better as configuration than as code branches. For a
> single client the same four jobs are simpler without a workflow engine:
>
> | Workflow | Replaced by |
> | --- | --- |
> | W01 lead intake | `POST /api/webhooks/hubspot/leads?campaign=<uuid>` — HubSpot posts its own payload straight to the platform |
> | W02 calling worker | `npm run worker` — a timer |
> | W03 qualification | nothing; the voice webhook qualifies a completed call inline |
> | W04 retry/callback | `npm run worker` — the same timer |
>
> The reason that substitution is safe is PRD 9's own rule: durable state lives
> in PostgreSQL, never in execution history. The queue claim is
> `FOR UPDATE SKIP LOCKED` with a lock expiry and the endpoints are idempotent
> on their own keys, so the scheduler is disposable — kill it, restart it, or
> run two by accident and no call is lost or duplicated.

Importable definitions for the four workflows in PRD 9. Import each JSON file
into n8n, then set the two credentials/variables they expect.

| File | PRD | Purpose |
| --- | --- | --- |
| `W01-lead-intake.json` | 9 W01 | HubSpot new-lead event -> platform intake |
| `W02-calling-worker.json` | 9 W02 | Scheduled tick that claims queued leads and dials |
| `W03-qualification.json` | 9 W03 | Analyse a completed call, then drain the sync outbox |
| `W04-retry-callback.json` | 9 W04 | Sweep due callbacks and retries back into the queue |

## What n8n does and does not own

n8n **orchestrates**; it does not hold state. PRD 9's engineering rules are
explicit: "Do not store call state only in n8n execution history; persist
durable state in PostgreSQL." So each node here is a thin HTTP call into the
platform, and the queue, locks, retry ladder, idempotency keys and outbox all
live in the database.

That also means a workflow can be re-run, duplicated, or fail halfway without
double-calling a lead - the endpoints are idempotent on their own keys
(PRD 18.1), not on n8n's execution id.

## Setup

1. **Credential** - create an n8n *Header Auth* credential named
   `Lead Platform Service Token`:
   - Name: `Authorization`
   - Value: `Bearer svc_...` (from `npm run db:seed:phase1`, or an Agency Admin)

   The token is bound to one tenant at issue time. PRD 8.2 forbids trusting a
   `tenant_id` supplied by a caller, so these workflows never send one - the
   platform derives it from the credential. A second client means a second
   token, not an extra field.

2. **Variables** - set `PLATFORM_URL` (e.g. `https://platform.example.com`)
   and `CAMPAIGN_ID` for the campaign a W02/W04 instance drives.

3. **Production URLs only.** PRD 9: "Use production webhook URLs only for live
   integrations; test URLs only for development." A production webhook needs
   the workflow to be published/active. [Ref. 1]

## Scopes

Each workflow needs only its own scope; issue separate tokens if you want to
narrow them further.

| Workflow | Scope |
| --- | --- |
| W01 | `leads:ingest` |
| W02 | `calls:dial` |
| W03 | `analysis:run`, `sync:drain` |
| W04 | `calls:dial` |

The voice provider posts call results to `/api/webhooks/voice/{provider}` with
scope `calls:result`; that callback is configured on the provider, not in n8n.
