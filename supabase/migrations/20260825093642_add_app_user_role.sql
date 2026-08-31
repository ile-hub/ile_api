-- The `postgres` role (used by the CLI/migrations and, until now, by the
-- app's DATABASE_URL) has BYPASSRLS in local Supabase by default. That
-- means every RLS policy from the init migration has been inert for any
-- connection using it: the policies exist, but nothing has actually been
-- enforcing them. The application must connect as a role that is neither
-- superuser nor BYPASSRLS, or RLS is decorative.
--
-- app_user is that role: plain LOGIN, no elevated attributes, not the
-- owner of any table it queries — so RLS applies to it with no extra
-- FORCE ROW LEVEL SECURITY needed (FORCE only matters for the table
-- owner; app_user isn't the owner of anything here).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user
      LOGIN
      PASSWORD 'app_user_local_dev'
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;

-- audit_log is append-only by design (see db/schema.sql's own note: "Revoke
-- UPDATE/DELETE grants on this table at the database role level" — this is
-- that). Explicit REVOKE of both, even though DELETE was never granted
-- above, so intent is unambiguous and survives any future blanket GRANT.
REVOKE UPDATE, DELETE ON audit_log FROM app_user;

-- Keep the grant applying to tables added by later migrations too, so this
-- doesn't silently drift as the schema grows.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO app_user;
