-- PROPOSED ONLY: requires the exact reviewed owner-approved database cutover.
-- No password is committed. A separately approved private activation step sets
-- a new password and LOGIN only after all grants/policies have been verified.
BEGIN;
CREATE ROLE aira_recorder_app_20261023 NOLOGIN NOINHERIT NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE postgres TO aira_recorder_app_20261023;
GRANT USAGE ON SCHEMA public TO aira_recorder_app_20261023;
GRANT SELECT, INSERT, UPDATE ON public.recordings, public.practice_sessions,
  public.players TO aira_recorder_app_20261023;
GRANT SELECT, INSERT ON public.scorecards TO aira_recorder_app_20261023;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_locations TO aira_recorder_app_20261023;

CREATE POLICY recorder_app_20261023 ON public.recordings FOR ALL
  TO aira_recorder_app_20261023 USING (true) WITH CHECK (true);
CREATE POLICY recorder_app_20261023 ON public.scorecards FOR ALL
  TO aira_recorder_app_20261023 USING (true) WITH CHECK (true);
CREATE POLICY recorder_app_20261023 ON public.practice_sessions FOR ALL
  TO aira_recorder_app_20261023 USING (true) WITH CHECK (true);
CREATE POLICY recorder_app_20261023 ON public.players FOR ALL
  TO aira_recorder_app_20261023 USING (true) WITH CHECK (true);
CREATE POLICY recorder_app_20261023 ON public.custom_locations FOR ALL
  TO aira_recorder_app_20261023 USING (true) WITH CHECK (true);
COMMIT;
