-- ═══════════════════════════════════════════════════════════════════════════
-- 0009 — What the lead actually asked for.
--
-- Until now a lead carried who it was and where it came from, but not what it
-- wanted. The form on the client's site collects that ("uPVC windows for a
-- 3BHK in Sector 78") and HubSpot holds it as a property, and it was being
-- dropped at intake.
--
-- It matters for two reasons. A verification call has to be able to say what
-- the enquiry was, or it cannot ask the lead to confirm it. And qualification
-- reads the transcript against the campaign's questions, so an agent that
-- already knows the stated requirement asks a shorter, less irritating call.
--
-- Encrypted at the application layer like the other lead-supplied columns
--. It is free text a member of the public typed into a form: not
-- identifying on its own, but it can easily contain an address or a name, and
-- treating it as PII costs nothing here.
-- ═══════════════════════════════════════════════════════════════════════════

alter table leads add column enquiry_enc bytea;

comment on column leads.enquiry_enc is
  'What the lead said they wanted, as captured by the upstream form and passed '
  'through by intake. AES-256-GCM at the application layer. Free text, never '
  'parsed for routing - it is spoken back to the lead for confirmation and '
  'read by the model as context.';
