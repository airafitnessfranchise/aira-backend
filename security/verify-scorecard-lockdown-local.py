#!/usr/bin/env python3
"""Restore a supplied archive in an isolated disposable lab and test F01.

Never accepts a production connection string. Private logs stay beside the
supplied archive, not in this repository. Docker must already have the image.
"""
import argparse, datetime, hashlib, json, os, pathlib, re, subprocess, time

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=pathlib.Path, required=True)
    parser.add_argument('--roles', type=pathlib.Path, required=True)
    parser.add_argument('--evidence', type=pathlib.Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    root = pathlib.Path(__file__).resolve().parent.parent
    image = 'public.ecr.aws/supabase/postgres@sha256:95d92e9563121189086690a4b7f8f2b711a4809a2499f45592199aae68ebae5f'
    name = 'aira-scorecard-security-lab-' + str(os.getpid())
    logs = args.archive.parent / (name + '.logs')
    tables = ['custom_locations','players','practice_sessions','recordings','scorecards']
    checks = []
    def run(argv, **kw):
        return subprocess.run(argv, capture_output=True, **kw)
    def query(sql, success=True):
        p = run(['docker','exec','-i',name,'psql','-X','-qAt','-h','/tmp','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'], input=sql.encode())
        with logs.open('ab') as f: f.write(p.stderr)
        if success: assert p.returncode == 0, 'Lab SQL failed; inspect private log'
        return p
    def scalar(sql): return query(sql).stdout.decode().strip()
    def snapshot():
        return scalar("SELECT jsonb_build_object('tables',(SELECT jsonb_agg(jsonb_build_object('name',relname,'rls',relrowsecurity,'acl',(SELECT jsonb_agg(to_jsonb(a) ORDER BY grantee,grantor,privilege_type) FROM aclexplode(relacl) a)) ORDER BY relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relkind='r'),'defaults',(SELECT jsonb_agg(jsonb_build_object('kind',defaclobjtype,'acl',(SELECT jsonb_agg(to_jsonb(a) ORDER BY grantee,grantor,privilege_type) FROM aclexplode(defaclacl) a)) ORDER BY defaclobjtype) FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname='public' AND pg_get_userbyid(defaclrole)='postgres')); ")
    def check_roles():
        for role in ['anon','authenticated']:
            for table in tables:
                for privilege in ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']:
                    assert scalar(f"SELECT has_table_privilege('{role}','public.{table}','{privilege}');") == 'f'
                    checks.append(role + '.' + table + '.' + privilege + '.denied')
                for operation in [f'SELECT 1 FROM public.{table} LIMIT 1', f'EXPLAIN DELETE FROM public.{table} WHERE false',f'TRUNCATE public.{table} CASCADE']:
                    p = query(f'BEGIN; SET LOCAL ROLE {role}; {operation}; ROLLBACK;', success=False)
                    assert p.returncode != 0 and b'42501' in p.stderr
                    checks.append(role + '.' + table + '.sql_denied')
        for role in ['postgres','service_role','aira_backup_reader']:
            for table in tables:
                query(f'BEGIN; SET LOCAL ROLE {role}; SELECT count(*) FROM public.{table}; ROLLBACK;')
                checks.append(role + '.' + table + '.read_allowed')
        for table in tables:
            p = query(f'BEGIN; SET LOCAL ROLE aira_backup_reader; EXPLAIN DELETE FROM public.{table} WHERE false; ROLLBACK;', success=False)
            assert p.returncode != 0 and b'42501' in p.stderr
            checks.append('backup.' + table + '.write_denied')
        assert scalar("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity") == '5'
    p = run(['docker','run','-d','--name',name,'--network','none','--memory','1g','--cpus','1','--user','postgres','--entrypoint','/bin/sh',image,'-c','initdb -D /var/lib/postgresql/lab -U postgres --auth-local=trust --auth-host=reject >/tmp/initdb.log 2>&1 && exec postgres -D /var/lib/postgresql/lab -c listen_addresses= -c unix_socket_directories=/tmp -c shared_preload_libraries=pg_stat_statements -c log_statement=none -c log_min_error_statement=panic'])
    assert p.returncode == 0, 'Lab container creation failed'
    try:
        for _ in range(30):
            if query('SELECT 1',success=False).returncode == 0: break
            time.sleep(1)
        state = json.loads(run(['docker','inspect',name]).stdout)[0]
        assert state['HostConfig']['NetworkMode'] == 'none' and not state['HostConfig'].get('PortBindings')
        roles = args.roles.read_bytes()
        roles = re.sub(rb'^CREATE ROLE postgres;\r?\n',b'',roles,flags=re.M)
        roles = re.sub(rb'^ALTER ROLE postgres WITH .*?;\r?\n',b'',roles,flags=re.M)
        roles = re.sub(rb' GRANTED BY [a-zA-Z_][a-zA-Z_0-9]*;',b';',roles)
        query(roles.decode())
        restored = run(['/opt/homebrew/opt/libpq/bin/pg_restore','--file=-',str(args.archive)])
        assert restored.returncode == 0
        query(restored.stdout.decode())
        before = snapshot()
        # The known exposure must reproduce before applying the operation.
        assert scalar("SELECT has_table_privilege('anon','public.recordings','SELECT')") == 't'
        assert scalar("SELECT relrowsecurity FROM pg_class WHERE oid='public.recordings'::regclass") == 'f'
        operation = (root/'security/scorecard-data-api-lockdown.sql').read_text()
        query(operation)
        check_roles()
        # Future db.js-created objects no longer inherit browser privileges.
        query('CREATE TABLE public.synthetic_future_scorecard(id bigserial PRIMARY KEY);')
        for role in ['anon','authenticated']:
            assert scalar(f"SELECT has_table_privilege('{role}','public.synthetic_future_scorecard','SELECT') OR has_sequence_privilege('{role}','public.synthetic_future_scorecard_id_seq','USAGE')") == 'f'
        query('DROP TABLE public.synthetic_future_scorecard;')
        locked = snapshot()
        replay = query(operation, success=False)
        assert replay.returncode != 0 and snapshot() == locked
        query((root/'security/scorecard-data-api-lockdown.rollback.sql').read_text())
        assert snapshot() == before, 'Rollback mismatch'
        query(operation)
        smoke = run(['node',str(root/'test/scorecard-restored-db-smoke.cjs')],env={**os.environ,'AIRA_SCORECARD_LAB_CONTAINER':name})
        assert smoke.returncode == 0, 'Real db.js lab smoke failed'
        smoke_result = json.loads(smoke.stdout)
        check_roles()
        result = {'status':'passed','verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'archive_sha256':hashlib.sha256(args.archive.read_bytes()).hexdigest(),
          'sql_sha256':hashlib.sha256(operation.encode()).hexdigest(),'image':image,
          'network':'none','published_ports':False,'production_mutations':False,
          'permission_checks':len(checks),'all_five_rls_enabled':True,
          'future_table_and_sequence_defaults_denied':True,
          'rollback_matches_initial_permissions':True,'repeat_apply_refused_atomically':True,
          'recorder_database_workflows':smoke_result,
          'proof_limit':'Database module and permission proof; no physical tablet, AI, email, or live write test.'}
        args.evidence.write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result))
    finally:
        run(['docker','rm','-f',name])

if __name__ == '__main__': main()
