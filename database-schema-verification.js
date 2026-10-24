const contract = require('./security/recorder-database-schema-contract.json');

const RIGHTS = Object.freeze({
  recordings: ['SELECT', 'INSERT', 'UPDATE'],
  scorecards: ['SELECT', 'INSERT'],
  practice_sessions: ['SELECT', 'INSERT', 'UPDATE'],
  players: ['SELECT', 'INSERT', 'UPDATE'],
  custom_locations: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
});
const ALL_RIGHTS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

const CATALOG_SQL = `SELECT jsonb_build_object(
  'user',current_user,
  'role',(SELECT jsonb_build_object('superuser',rolsuper,'create_role',rolcreaterole,
    'create_db',rolcreatedb,'bypass_rls',rolbypassrls,'replication',rolreplication,
    'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=r.oid))
    FROM pg_roles r WHERE rolname=current_user),
  'schema_create',has_schema_privilege(current_user,'public','CREATE'),
  'database_create',has_database_privilege(current_user,current_database(),'CREATE'),
  'public_definers',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE')),
  'extra_table_access',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND NOT(c.relname=ANY($1::text[]))
    AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
  'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity,
    'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
      'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object('type',co.contype,'definition',pg_get_constraintdef(co.oid)))
      FROM pg_constraint co WHERE co.conrelid=c.oid),
    'rights',(SELECT jsonb_object_agg(p,has_table_privilege(current_user,c.oid,p)) FROM unnest($2::text[]) p),
    'browser_access',has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
    'own_policy',(SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid AND p.polpermissive
      AND p.polcmd='*' AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname=current_user)]
      AND pg_get_expr(p.polqual,p.polrelid)='true' AND pg_get_expr(p.polwithcheck,p.polrelid)='true'),
    'applicable_policies',(SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid
      AND p.polroles && ARRAY[0::oid,(SELECT oid FROM pg_roles WHERE rolname=current_user)])) ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[]))) AS catalog`;

function fail() {
  const error = new Error('Recorder database schema or limited-role verification failed');
  error.code = 'RECORDER_DATABASE_SCHEMA_UNVERIFIED';
  throw error;
}

function assertRecorderCatalog(catalog, expectedUser) {
  if (!/^aira_recorder_app_\d{8}$/.test(expectedUser || '') || catalog?.user !== expectedUser) fail();
  if (!catalog.role || ['superuser','create_role','create_db','bypass_rls','replication']
    .some(k => catalog.role[k] !== false) || catalog.role.memberships !== 0) fail();
  if (catalog.schema_create !== false || catalog.database_create !== false
    || catalog.public_definers !== 0 || catalog.extra_table_access !== 0) fail();
  if (!Array.isArray(catalog.tables) || catalog.tables.length !== contract.tables.length) fail();
  for (const expected of contract.tables) {
    const table = catalog.tables.find(x => x.name === expected.name);
    if (!table || table.rls !== true || table.browser_access !== false
      || table.own_policy !== 1 || table.applicable_policies !== 1) fail();
    if (!Array.isArray(table.columns) || new Set(table.columns.map(x => x.name)).size !== table.columns.length) fail();
    for (const column of expected.columns) {
      const found = table.columns.find(x => x.name === column.name);
      if (!found || ['type','not_null','default'].some(k => found[k] !== column[k])) fail();
    }
    for (const constraint of expected.constraints) {
      if (!(table.constraints || []).some(x => x.type === constraint.type && x.definition === constraint.definition)) fail();
    }
    for (const right of ALL_RIGHTS) {
      if (table.rights?.[right] !== RIGHTS[expected.name].includes(right)) fail();
    }
  }
}

async function initializeRecorderDatabase({ pool, env = process.env, bootstrap }) {
  const mode = env.RECORDER_DATABASE_SCHEMA_MODE || 'bootstrap';
  if (mode === 'bootstrap') return bootstrap();
  if (mode !== 'verify' || !/^aira_recorder_app_\d{8}$/.test(env.RECORDER_DATABASE_EXPECTED_USER || '')) fail();
  try {
    const { rows } = await pool.query(CATALOG_SQL, [Object.keys(RIGHTS), ALL_RIGHTS]);
    if (rows.length !== 1) fail();
    assertRecorderCatalog(rows[0].catalog, env.RECORDER_DATABASE_EXPECTED_USER);
  } catch { fail(); }
  // This path does not perform DDL, mutate rows, or start listening on failure.
  console.log('[DB] Existing schema and limited application role verified');
}

module.exports = { initializeRecorderDatabase, assertRecorderCatalog, CATALOG_SQL, RIGHTS, ALL_RIGHTS };
