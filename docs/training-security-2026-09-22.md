# Signed-in training and AI request limits — September 22, 2026

Owner direction: Practice Bot and Closing Game are to be used through the Aira Staff app or dashboard going forward. Standalone public access is retired. Alyssa and Jasmine's separate MFA enrollment remains pending; their enforcement flags are not changed here.

## Access contract

`GET /admin/training-token` requires the existing active Aira admin session, including its normal MFA checks. Current `training.practice_bot` / `training.closing_game` permissions determine allowed activities. Role preview cannot mint another person's identity. The signed credential has a separate `AIRA-TRAINING` type and `aira-training` audience, a 30-minute expiry, a staff subject, server email/name, and assigned gym scope. It cannot authenticate to recorder administration/scorecards. The recorder verifies it before serving training pages or accepting any of the four practice POST routes.

Admin training embeds request this credential. Staff Account → Training requests it and opens the training page in the phone browser using existing Linking support (no native dependency/build change). A paid provider key is never put in an Aira app. Existing OpenAI voice mode still uses its short-lived Realtime client credential. The training credential is removed from the visible address after page load; responses are no-store/no-referrer. Treat a copied launch link as a temporary credential. Reopen training from Aira after 30 minutes. Existing account permissions and consultation-scorecard roles stay unchanged.

Game identification is bound to the signed email, progress reads resolve that email, and arbitrary player-cookie claims are removed. Existing email-associated game history is retained. New practice sessions belong to the signed staff ID; another staff token cannot turn/end the session. Location submissions must match assigned gyms (owner retains all gyms).

## Cost-abuse controls

Existing service-only `reserve_api_rate_limit` supplies durable atomic counters, so restarts, new tokens, and forwarded-IP spoofing do not reset a person's allowance. No database migration is needed. Quota/provider verification fails closed. Attempts are reserved before provider work and are not refunded on failure.

| Action | Per person / 24 hours | Whole company / 24 hours |
| --- | ---: | ---: |
| New text practice | 20 | 500 |
| Text turn | 300 | 5,000 |
| Score submission | 20 | 500 |
| Voice credential issuance | 3 | 25 |

There is also a combined 12-attempt/minute/person limit, one active request per person and four per recorder process, 2,000 characters per submitted message, bounded transcripts, and one scoring attempt per session. Practice provider requests time out after 45 seconds without SDK retries; practice scoring gets one attempt. Real recorded-consultation scoring retains its existing retry behavior. `TRAINING_AI_PAUSED=true` on the API rejects new practice actions independently of door/member/billing operations.

These are request ceilings, NOT a guaranteed dollar cap. Voice sessions are browser-to-provider after issuance: credential expiry does not terminate an already-open session, and client session configuration is not a trusted spending limit. Provider-side restricted projects/keys, actual spend cutoffs, and server-controlled voice lifetimes remain open. Concurrency is per process, not a cluster-wide semaphore. Other recorder upload/transcription routes and independent public VP data exposure remain separate audit items.

## Rollout and recovery

1. Release the API signer/quota endpoint first and verify health and authenticated/unauthenticated boundaries.
2. Release the dashboard and compatible Staff OTA, then activate the recorder gate. Old tabs need reopening; old standalone bookmarks receive a sign-in instruction.
3. Verify anonymous training POSTs fail before provider calls, signed synthetic pages load, a recorder admin token cannot replace a training token, and unchanged recorder health/scorecard access remains healthy. Run no paid production AI or email tests automatically.
4. Owner/staff perform one normal end-to-end practice and voice interaction to establish device/provider behavior. Automated tests alone do not establish it.

If training fails, preserve sign-in restrictions. Fix forward; use the API pause flag if cost containment is needed. Reverting the recorder gate would reopen public paid endpoints and requires explicit incident approval. No controller updates, signing-key rotation, membership/billing changes, or staff messages belong to this rollout.
