# Recorder administrator authentication

## Behavior

Aira Admin is the normal entry point for Scorecards and Training Library. It gets a
15-minute signed staff token from the existing API endpoint. This change preserves
that protocol, its supported roles (owner, VP, franchisee), and gym scope.

The historical built-in HTTP Basic password is removed. Basic access is disabled
unless the owner explicitly supplies a random `ADMIN_PASSWORD` of at least 32
non-padding characters. No recovery credential is created by this code change.
Password comparison is constant-time. Protected responses use `Cache-Control:
no-store` and `Referrer-Policy: no-referrer`. Invalid token errors are not logged by
the administrator middleware.

## Rollout impact

- Staff who use Aira Admin Scorecards keep the existing signed-in path.
- Old direct recorder bookmarks or the historical shared login return HTTP 401.
  Open Scorecards through Aira Admin to obtain a fresh token.
- Deploying restarts the recorder service and can briefly interrupt a live recording
  connection or practice session. Use a window without an active consultation and
  allow tablets to reconnect. Do not use an active recording as a smoke test.
- Member sign-in, membership data, billing, and door-controller software are outside
  this change. The separate rescore API key path is also unchanged.

## Verification

1. Verify the API and recorder have matching, nonempty `RECORDER_TOKEN_SECRET`
   values without displaying them. Verify the owner can reach Aira Admin Scorecards.
2. Run `npm test` and `node --check server.js`. Tests use synthetic credentials and
   an isolated HTTP handler; they do not start production workers.
3. Before release, confirm the intended Git revision, clean task tree, and no
   unexpected `origin/main` movement. Confirm a suitable recorder restart window.
4. After deployment, verify the service is healthy on that exact commit. Check an
   unauthenticated protected GET and the removed Basic login are rejected. Verify
   the existing signed staff-token path still passes authentication using a
   non-existent scorecard identifier to avoid disclosing consultation information.
5. Verify the owner can open Scorecards through Aira Admin. A protocol smoke test
   does not prove the owner's browser session or a physical tablet reconnect.

## Recovery

First refresh the signed-in Aira Admin session and reopen Scorecards. If the API
and recorder signing configurations differ, restore their known-good matching
configuration through the owner's provider account; never print the values.

If an independent temporary recovery path is necessary, the owner may configure a
new random `ADMIN_PASSWORD` with at least 32 non-padding characters in Railway and
store it separately. That credential grants full recorder administration. Test it
privately, then remove it once normal access is recovered. Do not restore the old
built-in default as a rollback. Prefer a forward fix that keeps the fallback closed.

## Boundaries

This fixes the default administrator-password exposure. It does not close the
separately tracked public practice/AI-cost routes, change API account MFA, rotate
Railway tokens, remove query-string staff tokens, or complete database/backup
hardening. Those require their own scoped remediation and verification.
