-- ═══════════════════════════════════════════════════════════════════════════
-- 0012 — Let the runtime roles read the migration ledger.
--
-- `/api/health` is the only thing a deploy can ask "did this actually come up
-- correctly?", and the most common way it does not is the one the old check
-- could not see: a database that answers `select 1` but holds no schema,
-- because the deploy is pointed at the wrong database or the migration step
-- was skipped. That reports healthy right up until the first request touches a
-- table.
--
-- Making readiness mean "migrated" requires reading schema_migrations, and the
-- runtime roles could not: the table is owned by the migration role and
-- 0002's grants are deliberately explicit rather than blanket, so nothing
-- reached it by default.
--
-- SELECT only, and only on this table. It holds filenames and checksums - no
-- tenant data, nothing that needs RLS - and the health endpoint publishes only
-- the *count* publicly, keeping the filename behind the same shared secret the
-- scheduler uses.
-- ═══════════════════════════════════════════════════════════════════════════

grant select on schema_migrations to app_user, app_service;

comment on table schema_migrations is
  'Applied migration ledger, checksummed. Readable by the runtime roles so '
  '/api/health can distinguish "database reachable" from "database migrated"; '
  'writable only by the migration owner.';
