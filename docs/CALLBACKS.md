# Callbacks

A callback is the one promise this platform makes on a client's behalf during
a call: *we will ring you back at that time*. This is how that promise is
tracked, kept, and — when it is not kept — surfaced to a person.

The screen is **Callbacks** in the sidebar. Everything below explains what it
is showing you.

---

## Contents

- [The shape of it](#the-shape-of-it)
- [Where a callback comes from](#where-a-callback-comes-from)
- [How one is kept](#how-one-is-kept)
- [How one becomes missed](#how-one-becomes-missed)
- [Working the queue](#working-the-queue)
- [Who can do what](#who-can-do-what)
- [What it does not do](#what-it-does-not-do)
- [Troubleshooting](#troubleshooting)

---

## The shape of it

Two things happen when a lead asks to be called back, and keeping them apart is
the whole design:

| | Where it lives | What moves it |
| --- | --- | --- |
| **The call** | `leads.next_call_at` | The retry ladder and the calling queue |
| **The promise** | a `callbacks` row | The dialler, the sweep, or an operator |

The queue never reads the `callbacks` table. It dials `leads.next_call_at` like
any other deferred call. The callback row *follows* what the dialler did rather
than instructing it.

Tying the two together would mean the queue reading a second table on every
claim, and an operator pressing "mark called" would silently cancel a real
queued call. Instead the row is a record of an obligation, and the queue is a
record of intent.

A callback has four states:

| Status | Meaning |
| --- | --- |
| `scheduled` | Outstanding. Shown on the page under **Past due** or **Upcoming**. |
| `completed` | A call went out after the requested time, or an operator closed it by hand. |
| `missed` | The time passed, the grace period passed, and no call was placed. |
| `canceled` | An operator decided it should not happen. |

---

## Where a callback comes from

One place: the qualification result. When the model returns
`callback_requested: true`, `commitAnalysis` writes the row
(`src/lib/qualification/pipeline.ts`).

- With a `callback_time_iso` in the future, that is the scheduled time, and the
  retry ladder puts the same time on `leads.next_call_at`.
- Without a usable time — absent, unparseable, or already past — the callback
  is scheduled for **24 hours out** and the lead goes back on the normal retry
  ladder rather than to a time nobody agreed to.

The row carries `call_id`: the call the lead asked *on*. That is deliberately
not the same field as `fulfilled_call_id`, which is the call that later
satisfied the request.

---

## How one is kept

`fulfilCallbacksForLead` runs inside the dialler, in the same transaction as
the call attempt (`src/lib/calling/worker.ts`). When a call goes out for a lead
that has a callback whose time has arrived, the callback becomes `completed`
and records the attempt that did it.

**On dial, not on connect.** The promise was to call back, and we did. Whether
anyone answered is the retry ladder's problem — and a no-answer that re-queues
the lead should not leave an operator with a callback to chase by hand.

A callback the sweep already marked `missed` is revived to `completed` if the
call finally happens. The call was late, not absent, and the row should say
what happened rather than what the sweep predicted.

---

## How one becomes missed

The scheduled sweep (`/api/cron/tick`, so every cron tick) calls
`markMissedCallbacks`. It marks a callback `missed` only when **both** hold:

1. The requested time is more than **120 minutes** ago
   (`MISSED_GRACE_MINUTES` in `src/lib/calling/callbacks.ts`), and
2. **no call attempt was started for that lead since the callback came due.**

The grace period stops a callback being called missed while the pass that would
place its call is still minutes away. The second condition stops a call that
*did* go out — and was already counted as completed — from being contradicted
by a later sweep.

Both are deliberately conservative. A false "missed" sends someone chasing a
lead that was already called, which is worse than a callback that stays
outstanding for an extra hour.

Nothing was backfilled when this shipped. Every callback row that predates it
stays `scheduled` until a call or a person resolves it: marking a year of
history `missed` at deploy time would have invented an operational failure
nobody could have acted on.

---

## Working the queue

The page groups outstanding callbacks into **Past due** and **Upcoming**, and
shows recently closed ones in a table. Each card carries what you need to
decide: the lead (masked to the last four digits), the campaign, the intent and
summary from the call that requested it, and where the lead actually stands
right now — its status, attempts, and next scheduled call.

Four actions, each audited:

**Reschedule** — moves the callback *and* the lead's `next_call_at`, then puts
the lead back on the queue. A requested time the dialler does not honour is a
note, not a reschedule.

> It will **not** resurrect a lead that is `suppressed`, `calling`,
> `quarantined`, `awaiting_analysis` or `pending_review`. The callback moves,
> the lead keeps its status, and the page tells you so. Rescheduling past a DNC
> would be exactly the kind of quiet failure this platform exists to avoid.

**Mark called** — closes the promise as kept. Deliberately does *not* touch the
lead: this is a statement about the obligation, not an instruction to the
dialler. If a queued call should also be stopped, do that on the lead.

**Mark missed** — closes it as not kept, before the sweep would.

**Cancel callback** — the request should not be honoured at all.

Each takes an optional note, stored on the row and written to the audit log.
Resolving is idempotent: a second press on a callback someone else already
closed returns *"This callback is no longer open. Reload the page."* rather
than rewriting the first resolution.

---

## Who can do what

| | Permission | Roles |
| --- | --- | --- |
| See the page | `call:read` | Agency Admin, Campaign Manager, Operations Manager, Analyst |
| Resolve or reschedule | `callback:write` | Agency Admin, Operations Manager |

`callback:write` sits with the Operations Manager for the same reason
`review:resolve` does: this is where a promise made on a call is either kept or
written off, and that should be one accountable role rather than anyone who can
open the page. Everyone else sees the queue read-only.

Every resolution writes an audit row — `callback.resolved`,
`callback.rescheduled`, `callback.fulfilled` or `callback.missed` — naming the
person or the service that did it. `resolved_by` is null when the platform
resolved it itself, which is how the page distinguishes "automatically" from a
named operator.

---

## What it does not do

- **No notification.** Nothing emails or Slacks anyone when a callback comes
  due or is missed. The dashboard count and this page are the only surfaces.
- **No per-callback assignment.** A callback belongs to the client, not to a
  named operator.
- **No bulk actions.** One at a time, on purpose: each is a decision about a
  named person who asked to be called.
- **Attribution can fade.** The resolver's email is read through a join on
  `users`, and row-level security hides staff not assigned to the tenant you
  are viewing. If someone's assignment is later removed, their resolution shows
  as "automatically" on this page — the audit log still names them.

---

## Troubleshooting

**A callback is past due but no call went out.**
Check the lead, not the callback. `next_call_at` drives the dialler: if the
lead is `suppressed`, out of attempts, or its campaign is paused or outside its
calling window, no call is placed and the callback will eventually be marked
missed. The card shows the lead's status and next call for exactly this reason.

**Everything is stuck in `scheduled` and nothing is ever marked missed.**
The sweep is not running. `markMissedCallbacks` only runs from
`/api/cron/tick`, which needs `CRON_SECRET` set and something calling it —
`npm run worker` locally, Vercel Cron in production. See
[`CONNECTING.md`](CONNECTING.md) step 5.

**A callback completed but the customer says nobody called.**
`completed` means an attempt was *placed* after the requested time, not that it
connected. Open the lead and look at the call history: a `no_answer` or `busy`
attempt completes the callback and re-queues the lead through the retry ladder.

**The completion rate on Analytics looks wrong.**
It is `completed / all callbacks` over the selected window. Before this feature
shipped nothing ever left `scheduled`, so any window covering that period reads
low and always will — those rows have no call behind them to find.
