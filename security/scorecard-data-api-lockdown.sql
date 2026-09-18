-- F01: one-time, separately approved operation for the scorecard database only.
-- Not a core ACSM migration and not applied merely by deploying this repository.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
DO $guard$
DECLARE actual text[];
BEGIN
  IF current_user <> 'postgres' THEN RAISE EXCEPTION 'Expected database owner'; END IF;
  SELECT array_agg(relname::text ORDER BY relname) INTO actual
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r';
  IF actual IS DISTINCT FROM ARRAY['custom_locations','players','practice_sessions','recordings','scorecards'] THEN
    RAISE EXCEPTION 'Unexpected database tables; inspect target and drift';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND (c.relkind IN ('v','m','S') OR
      (c.relkind='r' AND (c.relrowsecurity OR c.relforcerowsecurity OR pg_get_userbyid(c.relowner)<>'postgres'))))
    OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public')
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') THEN
    RAISE EXCEPTION 'Unexpected scorecard security state; inspect before applying';
  END IF;
END
$guard$;

ALTER TABLE public.recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scorecards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.practice_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.recordings, public.scorecards,
  public.practice_sessions, public.custom_locations, public.players
  FROM PUBLIC, anon, authenticated;

-- db.js creates tables as postgres. Keep future objects private by default.
-- Existing owner/service-role/backup-reader access remains unchanged.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
COMMIT;
