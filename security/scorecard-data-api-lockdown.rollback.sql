-- SECURITY-REDUCING EMERGENCY ROLLBACK. Requires separate owner approval.
-- Restores the exact public-access design observed September 17, 2026.
-- Prefer fixing the legitimate server path rather than reopening this exposure.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
DO $guard$
DECLARE actual text[];
BEGIN
  SELECT array_agg(relname::text ORDER BY relname) INTO actual
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r';
  IF current_user <> 'postgres' OR actual IS DISTINCT FROM
    ARRAY['custom_locations','players','practice_sessions','recordings','scorecards'] THEN
    RAISE EXCEPTION 'Unexpected rollback target';
  END IF;
END
$guard$;
ALTER TABLE public.recordings DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.scorecards DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.practice_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_locations DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.players DISABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON TABLE public.recordings, public.scorecards,
  public.practice_sessions, public.custom_locations, public.players TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated;
COMMIT;
