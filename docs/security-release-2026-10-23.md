# Recorder security release — October23,2026

Node22.23.4, Multer2.5.0 and uuid11.1.1 are pinned with package-lock and npm-ci.
Authenticated upload ordering, audio_file field,200MiB limit, audio formats and
business/AI processing are preserved. The patched parser cleans aborted uploads;
invalid/oversized multipart returns400/413.

Railway uses /health/ready (180s timeout). It returns200 only when the actual
runtime matches22.23.4. Listening still waits for existing startup. This is not
proof of every DB/AI operation. The diagnostic exposes no secrets.

Before release: clean npm-ci,43 tests, audit0, exact-revision CI and retained rollback.
The tests cover actual mocked startup, runtime mismatch, auth, valid formats,
metadata, malformed/aborted cleanup, size/field errors and later liveness. No live
upload, paid inference, reprocessing or outgoing email is used as a smoke test.

Rollback target is today's successful d65ec9ac-49fc-469c-868e-e2348522038b
(source0ad48d169d9162d3f5d131b7b45fe06a8669301a), which includes the replacement
Anthropic credential. Railway History's retained deployment actions expose Rollback.
Do not restore older pre-rotation variables. A source revert with the current
variables is the fallback. No live rollback rehearsal ran; old code rollback is
only temporary incident containment. Verify source/runtime/auth after any rollback.

Canonical procedures and observed live evidence belong in the API companion
`docs/security-updates-2026-10-23.md`; docs/manual-change.json records its immutable
merged commit. No schema, credential, member, billing, access or worker change.
