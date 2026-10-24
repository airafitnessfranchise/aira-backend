# Recorder database credential preparation

The current technical master is the API manual. This source adds a dormant schema-verification initializer for the separately reviewed recorder database cutover. With `RECORDER_DATABASE_SCHEMA_MODE` absent or `bootstrap`, existing initialization is preserved. `verify` requires the exact `RECORDER_DATABASE_EXPECTED_USER`, a compatible existing schema, minimal privileges and five role-only RLS policies. Unknown or missing verification metadata fails before listening, with no DDL fallback.

The proposed Supabase migration creates a NOLOGIN role with no password, no administrative/RLS-bypass attributes, limited grants and five role-only policies. It is not applied by the Railway start/deploy path. No role, grant, policy, password, data or connection change is activated by source deployment.

Preparation passed all55 tests under pinned Node22.23.4 and44 isolated PostgreSQL17 checks, including actual startup, required CRUD, browser denial and denied schema/role escalation. The lab uses only synthetic rows and no production credentials.

The future live sequence must confirm backup and all consumers, obtain the exact role/grant/password/restart approval, privately enable the new login, switch the recorder with verify mode, drain old processes, then retire the old administrator password. Recordings and signing keys stay intact; restarts can interrupt tablets/practice. Recover only compatible source with current replacement connection settings; native rollback can restore old credentials. No paid AI, upload, message, quota reservation or live rescore is a verification step.

The immutable technical companion is [API commit 0e99e7d3](https://github.com/Airafitness/aira-api/commit/0e99e7d39bff153468453501220faf4d67b51f0b) and its [cutover procedure](https://github.com/Airafitness/aira-api/blob/0e99e7d39bff153468453501220faf4d67b51f0b/docs/recorder-database-credential-cutover-2026-10-23.md). Authenticated Git/gh verified it on API main before this dependent source was committed.
