# Recorder credential handoff preparation

The technical master and staged procedure are in API commit
[`85f164f5`](https://github.com/Airafitness/aira-api/commit/85f164f59938b293c364e0d5963fb8aacd04fd79),
[recorder credential rotation preparation](https://github.com/Airafitness/aira-api/blob/85f164f59938b293c364e0d5963fb8aacd04fd79/docs/recorder-credential-rotation-preparation-2026-10-23.md).
This document records the recorder-side compatibility boundary, not a second
independently maintained system manual.

## Default-off behavior

Current configuration keeps existing single-key behavior. Only the exact string
`true` in `RECORDER_CREDENTIAL_ROTATION_ENABLED` enables the optional
`RECORDER_PREVIOUS_TOKEN_SECRET` reader. A current `RECORDER_TOKEN_SECRET`
remains required. Staff administration, upload authentication, training and
recording-result verification use the same gated key reader; result-token
issuance always uses the current primary. Role, gym, feature, recording-subject,
expiry, session and training quota checks remain in place. The API counterpart
also stages its sync-key reader before this service changes its sender.

The manual rescore `ADMIN_KEY` comparison is constant-time. No secondary admin
key, public endpoint, fallback credential or live rescore probe is introduced.
Normal Basic recovery remains disabled unless independently configured by the
owner with a strong password; no such fallback was configured at preparation.

## Required activation decision

No key is rotated or credential flag activated by this source preparation.
The owner must approve the exact three-credential, two-service sequence and its
maintenance window. Retiring the previous signing key invalidates old staff and
training tokens and seven-day recording-result links. Existing recordings and
scorecards remain. Authorized owner/VP/franchisee access through Aira Admin
Scorecards can obtain fresh sign-in tokens; ordinary old result links have no
automatic reissue path. The previous manual rescore key also stops working.

Recorder deployments can briefly disconnect tablets and practice sessions.
Check processing aggregates, but do not treat an idle database snapshot as proof
that no tablet is recording. No upload, live rescore, paid AI, quota reservation,
email or production-data mutation is an authorized verification probe.

## Tests and recovery

The isolated full suite passed50 tests on Node22.23.4 Linux arm64 with networking
disabled and source/dependency mounts read-only. Seven new transition tests use
synthetic tokens, the actual result handler, real admin/training middleware and
mocked data. They exercise both rolling generations, exact gate values, primary
requirements, primary-only issuance, retirement, purpose/expiry/subject rejection
and gym boundaries. Pinned GitHub CI remains the exact-commit release gate.

After the API primary switches, recover compatible code while preserving current
replacement keys and the still-required temporary readers. Railway native
rollback restores custom variables and must not restore exposed keys or remove
needed readers. Follow the single staged master procedure before changing a
writer or retiring any reader. The separate recorder database password, R2/AI
provider keys and previous stored-token encryption archive are outside this group.
