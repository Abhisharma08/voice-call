-- Callbacks become work, not just a record of a request.
--
-- Until now a callback row was written when a lead asked to be called back and
-- then never touched again: nothing ever moved it out of 'scheduled'. The
-- three other values of `callback_status` were unreachable, the dashboard's
-- "callbacks due" count could only grow, and the analytics page's callback
-- completion rate was structurally 0%.
--
-- The columns below are what a resolution needs to be accountable: when it was
-- resolved, by whom (null for the system), the call that fulfilled it, and a
-- note when a person overrode the outcome. `resolved_by` references users
-- rather than storing an email, so a renamed account does not rewrite history
-- through the FK.

alter table callbacks
  add column if not exists resolved_at       timestamptz,
  add column if not exists resolved_by       uuid references users(id),
  add column if not exists fulfilled_call_id uuid references call_attempts(id) on delete set null,
  add column if not exists note              text;

comment on column callbacks.resolved_at is
  'When this callback stopped being outstanding, whoever or whatever closed it.';
comment on column callbacks.resolved_by is
  'The staff account that resolved it by hand. Null when the platform resolved '
  'it itself - a call placed after the requested time completes the callback.';
comment on column callbacks.fulfilled_call_id is
  'The attempt that satisfied the request. Distinct from call_id, which is the '
  'call the lead asked on.';

-- The worklist reads by status and orders by time within it: overdue first,
-- then upcoming, then what was resolved recently. `callbacks_due_idx` is
-- partial on status = 'scheduled', so it cannot serve the resolved tab.
create index if not exists callbacks_tenant_status_scheduled_idx
  on callbacks (tenant_id, status, scheduled_for desc);

-- A callback already past its time, with a lead that is no longer going
-- anywhere, is missed - but only the sweep can say so, and only after a grace
-- period. Nothing is backfilled here: every existing row predates the code
-- that resolves them, and marking a year of history 'missed' at deploy time
-- would invent an operational failure that nobody could have acted on.
