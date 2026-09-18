# Scorecard database public-access restriction

Status: APPLIED AND VERIFIED in production on September 17, 2026 (Central).

On September 17, 2026 (Central), all five public scorecard tables still had RLS
disabled and full anonymous/authenticated grants. Zero-row anonymous REST HEAD
requests returned HTTP 200 for every table. No private records were retrieved in
those probes. This database is separate from the main member/access system.

The current Railway production recorder configuration points to this database
as `postgres`. Its `db.js` uses the server database connection; the recorder
browser pages call the backend. The existing signed owner/VP/franchisee
authentication and gym scoping remain the normal staff entry point. No user
password reset or new recorder sign-in is part of this change.

## Approved operation

The owner approved and applied `security/scorecard-data-api-lockdown.sql` against the verified
scorecard project, `pwnpflntshqbpxvswgin`, after a fresh preflight. Do not replay it.
It is a guarded, single-transaction operation, not a core migration or a
deployment hook. It:

- Enables RLS on `recordings`, `scorecards`, `practice_sessions`,
  `custom_locations`, and `players`, with no public policies.
- Removes all table privileges from PUBLIC, `anon`, and `authenticated`.
- Removes automatic browser grants on future tables/sequences created by the
  recorder's `postgres` identity in `public`.
- Leaves existing owner, service-role, and read-only backup access intact.

SQL SHA-256:
`e78b2928bc333f1613166a80c3f74cc7868c2174d2360b87b4167562a1bcc93b`

No records are changed or deleted. No member, door, billing, AI, email, or other
provider setting is changed. An undocumented integration that directly uses the
public scorecard Data API would stop working. Staff using the existing recorder
server should continue normally. Locks are limited to three seconds; a timeout
rolls the operation back rather than waiting indefinitely.

## Completed verification

`security/scorecard-data-api-lockdown.validation.json` records the isolated proof:

- Today's independently backed-up scorecard archive was restored in PostgreSQL
  17 with Docker networking disabled and no published ports.
- 260 permission checks passed across apply and re-apply, including public-role
  denials, owner/service-role/backup reads, and denied backup writes.
- The real `db.js` performed 36 queries covering startup and all five tables:
  recording creation/update/read, scorecard creation/history, player creation/
  update/read, practice-session write/read/leaderboard, and location add/edit/delete.
- A future synthetic table/sequence inherited no browser access.
- An accidental repeat apply was refused atomically. The emergency rollback
  restored the exact original grants/defaults/RLS, then the restriction was
  re-applied successfully. The disposable container was removed.
- Existing recorder authentication tests: 16/16 passed, including the signed
  owner, VP, and franchisee paths and unauthenticated/default-password rejection.
- Production read-only preflight: recorder `/status` HTTP 200; database target
  and owner identity matched; no live recording or synthetic production row made.

This proves database compatibility, not a new physical tablet recording, AI
score, email delivery, or full incident recovery. Those are distinct checks.

## Apply and verify sequence

1. Recheck the production recorder revision/database target, table inventory,
   owners, grants/defaults, RLS/policies, absence of public functions/views, and
   backup-reader access. Stop on unexpected drift.
2. Apply exactly the reviewed SQL in its transaction.
3. Verify five RLS-enabled tables, no effective public-role privileges, unchanged
   legitimate owner/service/backup privileges and provider security advisors.
4. Repeat zero-row REST HEAD probes; require denial. Check recorder health and
   authenticated read-only staff access. Do not trigger paid work or tablet
   recording. Document any interactive staff check still pending.
5. Record the live receipt and update the master security register/manual.

Rollback SQL is supplied for an approved incident response. It reopens the
original public exposure and must not run automatically. If a legitimate
integration fails, prefer repairing its authenticated server path.

## Remaining boundaries

New public RPCs, views, or objects created by another owner still require review;
this operation does not change provider-owned default privileges. The recorder
retains its broad database-owner connection and current TLS configuration, tracked
under F12. Public paid-practice/test/upload routes are a separate F18 hardening
task. This change does not establish that no prior data access occurred.

Reference: [Supabase Data API grants and RLS](https://supabase.com/docs/guides/api/securing-your-api).

## Production receipt — September 17, 2026, 7:14 PM Central

The owner approved this exact restriction and normal verification in the task.
The first CLI attempt failed before SQL execution due to a relative file path;
one corrected absolute-path retry applied the unchanged reviewed SQL.

- All five tables have RLS enabled; effective public table and column privileges
  are zero. Future public table/sequence defaults for the recorder owner are zero.
- Anonymous zero-row REST HEAD requests now return HTTP 401 on all five tables.
- The recorder `/status` and a signed staff-token `/admin` HEAD both return 200;
  unauthenticated `/admin` returns 401. The staff probe used a synthetic owner token
  valid for 60 seconds, not an interactive human sign-in. No token was saved.
- The dedicated backup reader connects with certificate/hostname-verified TLS
  and reads all five tables; EXPLAIN write checks are denied on all five.
- Before/after counts match: 84 recordings, 86 scorecards, 46 practice sessions,
  six custom locations, and 14 players. No production records were modified.
- Supabase's security advisor reports no warning/error findings. Its five
  [RLS-without-policy informational notices](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
  are expected: direct browser access is intentionally denied and the backend
  owner connection remains the access path. No permissive policy was added.

The combined non-secret receipt is `security/scorecard-data-api-lockdown.live.json`.
F01 is mitigated live; historical access review and a physical tablet/AI/email
workflow observation remain open. F12 and F18 are not closed by this change.
