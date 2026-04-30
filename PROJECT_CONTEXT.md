# Aira Fitness Backend — Project Context

This document explains what the Aira Fitness Consult Recorder + Closing Game backend does, how the pieces fit together, and the design decisions behind them. Drop this into a Claude project so future sessions have the full context.

**Repo:** `airafitnessfranchise/aira-backend` (main branch)
**Live URL:** `https://aira-backend-production-2a71.up.railway.app`
**Hosting:** Railway, auto-deploys on push to main, ~60s.
**Stack:** Node.js + Express, Postgres (Supabase), Anthropic Claude API, OpenAI Whisper, Resend (email), Cloudflare R2 (audio storage).

---

## What this system is

A complete sales coaching platform for Aira Fitness franchisees. Three concurrent products:

1. **Consult Recorder.** Tablet at the gym front desk records the consultation, uploads audio, the backend transcribes it, scores it against the Aira sales process, and emails the franchisee + Mike + (optionally) the VP a branded scorecard with coaching notes. Stored permanently for training data.
2. **Practice Bot at `/practice`.** Franchisees role-play a mock consultation against an AI prospect, get scored at the end with the same rubric. 11 prospect personas across 3 difficulty levels.
3. **Aira Fitness Closing Game at `/airafitnessclosinggame`.** Gamified leveled progression — 5 levels, scenarios you must close to unlock the next, XP, leaderboard, dark glassmorphism design with confetti on level-up. Same persona library as `/practice` underneath.

All three feed the same `practice_sessions` corpus (mode flag distinguishes them) which is queryable for training material, drift analysis, and per-rep coaching.

---

## URLs

| URL                                   | Audience                | Auth                               |
| ------------------------------------- | ----------------------- | ---------------------------------- |
| `/admin`                              | Mike + VPs              | Basic Auth (admin / airafitness)   |
| `/admin/library`                      | Mike + VPs              | Basic Auth                         |
| `/scorecard/:id`                      | Mike + VPs              | Basic Auth                         |
| `/playback/:recording_id`             | Mike + VPs              | Basic Auth                         |
| `/practice`                           | Franchisees (open)      | None                               |
| `/airafitnessclosinggame`             | Franchisees (open)      | None                               |
| `/airafitnessclosinggame/progress`    | Game client             | None                               |
| `/airafitnessclosinggame/leaderboard` | Game client             | None                               |
| `/practice/start`, `/turn`, `/end`    | Practice + game clients | None                               |
| `/admin/rescore/:id`                  | Mike (curl/automation)  | `X-Admin-Key` header               |
| `/upload/recording`                   | Tablet                  | Open (filed by GHL appointment_id) |
| `/webhook/ghl`                        | GoHighLevel             | Open, currently disabled           |
| `/status`                             | Health check            | Open                               |

---

## Auth model

Two completely separate auth systems on purpose:

1. **HTTP Basic Auth** (`adminAuth` middleware in `server.js`) gates browser-facing admin pages. Username `admin`, password `airafitness` by default; override by setting `ADMIN_PASSWORD` env var in Railway. Browser prompts natively. Applied to `/admin`, `/admin/library`, `/scorecard/:id`, `/playback/:id`.
2. **`X-Admin-Key` header** gates the `/admin/rescore/:id` automation endpoint. The key is in the `ADMIN_KEY` Railway env var. Used for one-off operations like manually re-scoring a stuck recording.
3. **`/practice` and `/airafitnessclosinggame` are intentionally unauthenticated.** Franchisees use them freely. The game uses a cookie-generated UUID (`aira_player_id`) as identity — no login screen, persistence per-browser.

---

## The Consult Pipeline

Tablet records → upload → R2 → transcribe → score → save → email.

```
POST /upload/recording (audio_file, appointment_id, location_id, contact_name)
  ↓
db.createRecording  (or update if appointment_id matches an existing row)
  ↓
processRecording (server.js) — fire-and-forget, returns 200 immediately
  ↓
  uploadToR2(audioFilePath, recording_id)            → r2_key
  updateRecording(processing_status='transcribing')
  transcribeAudio(audioFilePath)                      → OpenAI Whisper
  updateRecording(transcript, processing_status='transcribed')
  updateRecording(processing_status='scoring')
  scoreTranscript(transcript)                         → Claude Opus 4.5
  db.createScorecard({recording_id, scorecard})
  updateRecording(processing_status='scored')
  getPresignedUrl(r2_key)                             → audioUrl (7-day expiry)
  sendScorecardEmail(location, recording, scorecard, audioUrl)
```

If anything throws, the recording is marked `processing_status='failed'`. A startup reaper (`runReaper` in server.js, called after `initDb`) finds any recordings stuck in `transcribing` or `scoring` for more than 5 minutes and re-enqueues them. This handles deploys that interrupted in-flight scoring.

`/admin/rescore/:id` lets Mike manually re-trigger scoring on any recording. If the recording already has a transcript, it skips Whisper and goes straight to Claude scoring. `?test_only=1` sends the email to Mike only — useful for testing prompt changes without spamming franchisees.

---

## Data Model

### `recordings`

| column            | notes                                                                       |
| ----------------- | --------------------------------------------------------------------------- |
| recording_id (PK) | UUID                                                                        |
| appointment_id    | from GHL or `manual-{ts}`                                                   |
| location_id       | canonical (see below)                                                       |
| contact_name      | "Walk-in" by default                                                        |
| audio_file_url    | local path                                                                  |
| r2_key            | Cloudflare R2 key                                                           |
| transcript        | Whisper output                                                              |
| duration_seconds  |                                                                             |
| recorded_at       | TZ                                                                          |
| processing_status | pending / uploaded / transcribing / transcribed / scoring / scored / failed |

### `scorecards`

| column                                                            | notes                                                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| scorecard_id (PK)                                                 | UUID                                                                         |
| recording_id (FK)                                                 | one recording can have multiple scorecards (every rescore creates a new row) |
| total_score                                                       | 0-100                                                                        |
| sitdown_score, objection_score, language_score, close_score       | each 0-25                                                                    |
| ai_summary                                                        | 2-sentence summary                                                           |
| coaching_note, overall_coaching                                   | full coaching narrative                                                      |
| {section}\_score_explainer                                        | per-bar explainer (1-2 sentences)                                            |
| {section}\_what_said, {section}\_what_to_say, {section}\_coaching | per-section detail                                                           |
| process_warning                                                   | populated when did_close=true AND total<70                                   |
| flagged_for_review                                                | true when total<70                                                           |
| did_close                                                         | true if a paid sale was made                                                 |
| created_at                                                        | for ORDER BY DESC LIMIT 1 in queries — every rescore appends                 |

**Important:** scorecards are NEVER deleted. Every rescore appends a new row. Live dashboard analytics dedupe to latest-per-recording; historical rows are kept for training and drift analysis. `db.getScorecardHistory(recording_id)` returns all versions chronologically.

### `practice_sessions`

Mirrors `scorecards` columns (so practice and consult data are uniform), plus:

| column          | notes                                            |
| --------------- | ------------------------------------------------ |
| session_id (PK) | UUID                                             |
| location_id     | canonical                                        |
| difficulty      | easy / medium / hard                             |
| persona_label   | e.g. "Medium — Mike"                             |
| scenario_id     | e.g. "mike-construction"                         |
| player_id       | UUID, set when mode='game'                       |
| player_name     | display name, optional                           |
| mode            | 'practice' or 'game'                             |
| messages        | JSONB — full conversation in chronological order |

`mode='game'` rows are the only ones counted toward game progress. `db.getPlayerGameProgress(player_id)` returns per-scenario passes, total XP, attempts, closes. `db.getGameLeaderboard()` returns top 25 by total XP across all game players.

---

## Locations

Defined in `locations.js` as a hardcoded array. Each location has `location_id`, `franchise_name`, `franchisee_name`, `franchisee_email`, optional `vp_email`, optional `club_email`, `ghl_calendar_id`.

**Canonical IDs.** `canonicalLocationId(id)` maps known historical aliases to the current canonical ID. Currently: `fox-lake` → `fox-lake-01`, `fox-lake-01'` (stray apostrophe) → `fox-lake-01`, `mishawaka` → `mishawaka-01`. Used in `/admin` analytics so old recordings merge into their current location.

---

## The Scoring System

The single most important file in the project is `ai.js` — it contains the SCORING_PROMPT (~700 lines) that grades every consult and every practice/game session.

### Coaching Philosophy (the override)

The prompt has a top-level COACHING PHILOSOPHY section that overrides everything below it. Five principles:

1. **Closing is the goal.** Reward creative wins; explain WHY they worked psychologically. Don't punish deviations that produced the right feeling.
2. **Psychology fluency is the real prize.** Wording is the vehicle, understanding is the destination.
3. **Bad habits are the real enemy.** Lead-with-discount, accept-walkaway, skip-urgency, close-while-standing — coach hard against these even when the rep happened to close.
4. **Grow the person.** Coach like Mike Bell would coach his own brother.
5. **The script is a tool, not a test.** Substance over verbatim wording.

### Question-Led Leadership

A second prompt section explicitly distinguishes **strategic questions** (the technique) from **true permission-seeking** (a weakness):

- **Strategic (never dock):** tie-downs ("Did you like the gym?"), engineered-yes questions ("Would that help you out?", "Would you like me to grab that for you?" once cost is on the table), discovery isolation ("Is it more about the upfront cost?"), "Make sense?", "Is that fair?"
- **True permission-seeking (DOCK):** "Do you want to join?", "Are you ready?", "What do you think?" after pricing — questions that hand the prospect a no-button when forward motion was the move.
- **Test:** did the question give an OUT they shouldn't have had? If no, it's leading.

### The Aira Process (taught to the model)

The prompt walks the model through every step of the Aira sales process so it can grade against the right bar:

1. **The Tour** — rapport before pricing
2. **The Sit-Down** — month-to-month / no contracts / cancel anytime / first + last + enrollment / "like every other gym" / "Make sense?" (5 components — that's the bar; do NOT invent additional clarifiers like "one-time fee, not yearly")
3. **The Assumptive Close** — "Which one would you like to get started with today?" then immediate ID collection: "Awesome. Do you have your ID and I can create your profile." (statement of forward motion — NOT "Do you have your ID to get you started?" which re-introduces a decision point)
4. **Tie-Downs** when buying signals appear
5. **The Deaf Ear Close** on first objection (before any offer): "I totally understand. Did you like the gym? Does it have everything you need? Is it more about the upfront costs?"
6. **The Coupon Drop** (only after Deaf Ear isolates cost): "Did you get our coupon mailer we sent out a couple weeks ago? It discounted the enrollment 50%."
7. **The Google Review Drop** (LAST resort, only after coupon declined AND no payment-timing solution works): waives enrollment in exchange for a review + referrals. Renamed from "Brand Ambassador Drop" — that was Claude's invention.
8. **Free Pass Sequence** — when prospect asks to try first. Collect info, sign agreements, THEN mention the $25 activation. Use By The Way Close at end of visit.
9. **Post-close** — PIF offer + referral collection.

### Revenue Priority (within objection handling)

Cost hierarchy, lowest-to-highest expense to the franchise:

1. Full price
2. Coupon Drop (50% off enrollment)
3. **Payment-timing solution** (full price, deferred — post-date to payday, split billing) — closes at full price
4. Google Review Drop (waives enrollment entirely)

A rep who closes at full price via payment-timing has executed the BEST outcome. Do NOT coach them down to the Google Review Drop. The model is told this explicitly.

### Spouse / Girlfriend / Partner Objection (specific script)

The correct sequence (NOT "invite her in for a tour"):

1. Run the Deaf Ear: "Did you like the gym? Does it have everything? Is it more about cost or whether you like the gym?"
2. If cost — Coupon Drop / payment-timing.
3. If genuinely about her approval — "If your girlfriend doesn't join, would you still be interested?" (almost always yes)
4. Once yes — close today + honor the relationship: "I can get you signed up today and I'll put a free pass on your account for her to come try the gym out. Is that fair?"

Locks in the prospect's commitment and brings the partner IN via free pass instead of letting the prospect leave the desk.

### Scoring Categories (each 0-25)

- **Sit-Down Presentation** — five components hit before price sheet flipped, all 3 tiers presented, assumptive close used, never closed standing
- **Objection Handling** — Deaf Ear before any offer, payment-timing tried before Google Review Drop, drops in correct sequence
- **Language & Psychology** — assumptive vs true permission-seeking (NOT strategic questions), tie-downs run, calm under objections
- **Close Execution** — assumptive close used, ID collection assumed (no hedge phrases), re-closed after objections, By The Way / PIF / referrals collected

### Passing Score Thresholds

| Total            | Coaching header                      | Meaning                                  |
| ---------------- | ------------------------------------ | ---------------------------------------- |
| 85+              | `PERFECT EXECUTION`                  | Excellence — internalized the psychology |
| 70-84 + closed   | `YOU CLOSED IT — BUT READ THIS`      | Solid close with coachable gaps          |
| 70-84 + no close | `STRONG WORK — ONE THING TO TIGHTEN` | Right process, gap was elsewhere         |
| <70              | `HERE'S WHAT TO FIX FIRST`           | Structural moves missing                 |

`FLAG_SCORE_THRESHOLD` env var (default 70) flags scorecards for review when total < threshold. The number 70 is the operational "passing" line throughout the system.

### Output schema

The prompt asks Claude to return JSON with: total + four section scores, did_close, ai_summary (2 sentences), per-section explainer + what_said + what_to_say + coaching, process_warning (only when did_close=true AND total<70), overall_coaching (300-700 words). Backend validates all required fields, retries up to 3 times on JSON parse failures.

---

## Email Templates (`email.js`)

### Consult Scorecard Email (`sendScorecardEmail`)

Sent to franchisee + Mike + (optional) VP + (optional) club email. Brand palette: Black `#0A0A0A`, Brand Blue `#00AEEF`, Brand Blue Dark `#0284C7`, neutral grays, alert red `#DC2626` only for sub-50 / flagged. **NO green, NO orange.**

Layout:

- Black header band with `AIRA FITNESS` text wordmark (AIRA in blue, FITNESS in white) — same wordmark on every page
- White sub-header with brand-blue accent rule, `CONSULTATION SCORECARD` eyebrow, big franchise name (so VPs see it instantly), date
- Greeting (uses `greetingNameFor(location)` — falls back to "Aira Fitness Mishawaka Team" when `franchisee_name` matches `/employee|test|placeholder/i`)
- Big overall score with sale-closed pill (black with brand-blue check)
- Four category bars with explainers
- Summary callout (neutral card, brand-blue left rule)
- Coaching narrative card (brand-blue left rule, paragraph-split)
- Audio block — black "Listen / Download" CTA, link expires 7 days
- Inline full transcript

### Practice Email (`sendPracticeEmail`)

Same brand language. Sent to MIKE_EMAIL only (internal training data). Subject: `Practice — <franchise> — <persona> — <score>/100`. Body includes the score, bars, summary, coaching narrative, and the full conversation rendered as alternating `YOU SAID` / `PROSPECT SAID` cards.

---

## /practice — The Objection Bot

Single-page chat at `/practice`. Pick difficulty + your gym → bot's opening line → you type, it responds in ~1 second (Claude Haiku 4.5 for chat). Click `End & Score` → full scorecard renders inline (Opus 4.5 for scoring, ~30s).

### 11 Personas across 3 Difficulties

| Difficulty | Personas                                                                                                                                                                                                                               | Tests                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Easy       | Sarah (new mom, 80% sold), Marcus (contract-skeptical), Tasha (athlete, equipment-focused)                                                                                                                                             | The basic process                              |
| Medium     | Mike (cost — closes on Coupon Drop), Daniela (payday timing — payment-timing close), Brandon (comparing gyms — Coupon after Deaf Ear), Stephanie (gym-quitter — accountability framing)                                                | Different objections + matching the right tool |
| Hard       | Jessica (PF/LA Fitness comparison + stacked objections), Carlos (burned by 3 prior gyms — trust under skepticism), Megan (intimidated, hides under spouse objection — emotional layer), Trent (business owner — credibility questions) | Full sequence under pressure                   |

### Recently-Seen Filter

Each session writes the persona's `scenario_id` to a 30-day cookie (`aira_seen`) on the rep's browser. The next session reads the cookie and biases the random pick away from recently-seen IDs, so reps don't get the same prospect twice in a row. Falls back to a fully random pick if everything's been seen.

### Scenario starts at the desk

Every persona's opening line acknowledges the gym tour is already done and the prospect is sitting at the rep's desk. The system prompt explicitly tells the model "Do NOT role-play the tour or rapport phase — that already happened. Start at the desk." Cuts the awkward typing-through-the-tour phase that practice users were stuck on; focuses every session on sit-down + pricing + objections + close.

### Persistence

Every scored practice session is saved to `practice_sessions` with `mode='practice'`, full conversation in `messages` JSONB, and the full scorecard. Email fires to Mike. Database row never deleted.

---

## /airafitnessclosinggame — The Closing Game

Gamified leveled progression at `/airafitnessclosinggame`. Same persona library as `/practice`, but with progression mechanics + dramatic visual design.

### 5 Levels

| Level | Name         | Title                          | Personas                      |
| ----- | ------------ | ------------------------------ | ----------------------------- |
| 1     | Rookie       | Welcome to the Floor           | Sarah                         |
| 2     | Street Smart | Different Kinds of Easy        | Marcus, Tasha                 |
| 3     | Deaf Ear     | When 'Let Me Think' Means Cost | Mike, Brandon                 |
| 4     | Negotiator   | Creative Closes at Full Price  | Daniela, Stephanie            |
| 5     | Boss         | The Toughest Closes            | Jessica, Carlos, Megan, Trent |

**Pass condition (per scenario):** `did_close=true` AND `total_score >= 70`.
**Pass condition (per level):** at least one scenario in the level passed. Each level unlocks the next.
**XP** = sum of total_scores from passed scenarios.

### Identity (no login)

`aira_player_id` cookie generated on first visit (UUID). `aira_player_name` and `aira_player_location` cookied on splash form submit. Returning players skip splash and go straight to level map. Per-browser progression — different browser = different player.

### Visual Design

- Dark background (`#05080F`) with animated aurora gradient (radial blue/violet/pink, drifts every 20s)
- Star field overlay (subtle radial dots)
- Glassmorphic cards (`rgba(255,255,255,0.03)` bg + `backdrop-filter: blur(12px)`)
- Gradient-text headlines (brand-blue → violet → pink)
- Level cards have color-coded glow per level (`#22D3EE` → `#06B6D4` → `#0284C7` → `#7C3AED` → `#EC4899`) + lock/unlock/check states
- Persona avatars: gradient circles with initial
- 80-particle CSS confetti burst on level pass
- Smooth fade-in animations on bubbles, slide-up on screens

### Endpoints

- `GET /airafitnessclosinggame` — full SPA-style page
- `GET /airafitnessclosinggame/progress?player_id=X` — per-player progress JSON
- `GET /airafitnessclosinggame/leaderboard` — top 25 by XP

Game sessions reuse `/practice/start`, `/practice/turn`, `/practice/end` with `mode=game` flag.

---

## /admin — Internal Dashboard

Auto-refreshes every 30 seconds. Sections from top to bottom:

1. **KPI cards (6)** — Recordings, Scorecards (with "X total in history" footnote since rescores never delete), Total Closes, Close Rate (with 30-day sparkline), Avg Score (with 30-day sparkline), Tablets Online
2. **Per-Location Leaderboard** — every location with at least one recording, sorted weakest avg score first. Columns: Consults, Closes, Close %, Avg Score, Last Activity. Color-coded score/rate cells.
3. **Avg Score by Category** — four bars (Sit-Down / Objection / Language / Close), sorted weakest first so the systemic gap is at the top
4. **Top Coaching Themes** — 11 patterns of recurring mistakes scanned across all coaching text (regex against `overall_coaching`, `process_warning`, all per-section coaching/explainers). Top 8 by frequency. Severity colored by % of consults exhibiting it.
5. **All Recordings** — full table, status pills (scored = solid black pill, others colored by stage), score pill (links to scorecard detail), Audio link

Linked from header: `Training Library →` (`/admin/library`) and `Practice Bot →` (`/practice`).

### `/admin/library`

Best/worst pairs gallery. For each of 7 prospect objections (think about it / spouse / can't afford / try it first / come back later / just looking / payday timing), scans every transcript for the objection phrase and groups by closed vs not-closed. Shows up to 2 closed examples opposite up to 2 no-sale examples per objection — real transcript excerpts with the objection phrase highlighted. Each card links to `/scorecard/:id`.

### `/scorecard/:id` and `/playback/:id`

Brand-language pages matching the email layout. Scorecard shows the full breakdown + transcript. Playback has the audio player + transcript.

---

## Code Layout

| File                             | Purpose                                                                                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.js`                      | Express app, all routes (admin, practice, game, scorecard, playback, upload, GHL webhook), `processRecording` pipeline, `runReaper`, `adminAuth` middleware                                                |
| `ai.js`                          | SCORING_PROMPT (~700 lines), Whisper transcribe, Claude scoring, the 11 PROSPECT_PERSONAS, GAME_LEVELS, startPracticeSession + chatAsProspect + scorePracticeSession (in-memory session store, 30-min TTL) |
| `db.js`                          | Postgres schema (`recordings`, `scorecards`, `practice_sessions`), all CRUD helpers, `getPlayerGameProgress`, `getGameLeaderboard`, `findAndReapStuckRecordings`, `getScorecardHistory`                    |
| `email.js`                       | `sendScorecardEmail`, `sendPracticeEmail`, brand palette constants, `coachingHeaderFor`, `greetingNameFor`, `scoreRowHtml`                                                                                 |
| `locations.js`                   | Hardcoded location array, `byLocationId` + `byCalendarId` lookups, `canonicalLocationId` alias mapper                                                                                                      |
| `storage.js`                     | Cloudflare R2 upload + presigned URL                                                                                                                                                                       |
| `vp-routes.js`, `public/vp.html` | Separate VP dashboard (out of scope here)                                                                                                                                                                  |
| `public/recorder.html`           | Tablet recording UI                                                                                                                                                                                        |

---

## Environment Variables

| Variable                                           | Purpose                                        | Default if unset                                      |
| -------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| `DATABASE_URL`                                     | Postgres connection string                     | required                                              |
| `ANTHROPIC_API_KEY`                                | Claude API for scoring + chat                  | required                                              |
| `OPENAI_API_KEY`                                   | Whisper transcription                          | required                                              |
| `RESEND_API_KEY`                                   | Email delivery                                 | required                                              |
| `MIKE_EMAIL`                                       | Recipient for all scorecards + practice emails | `mikebell@airafitness.com`                            |
| `EMAIL_FROM`                                       | Resend sender                                  | `onboarding@resend.dev`                               |
| `ADMIN_PASSWORD`                                   | Basic Auth for /admin pages                    | `airafitness`                                         |
| `ADMIN_KEY`                                        | Header auth for /admin/rescore                 | `5979e9f509...665e0d...` (set in Railway)             |
| `FLAG_SCORE_THRESHOLD`                             | flag for review when total<this                | 70                                                    |
| `PUBLIC_URL`                                       | Used in email links                            | `https://aira-backend-production-2a71.up.railway.app` |
| `PORT`                                             | server port                                    | 3000                                                  |
| R2-related (key, secret, bucket, account_id, etc.) | Audio storage                                  | required                                              |

---

## Source of Truth

**`Aira_5Day_Training_v10__1_.pdf`** is the canonical reference for every script and process. The scoring prompt explicitly references this PDF as the source of truth. When teaching a script, the model quotes verbatim from this document. When scoring a rep, it judges against intent + outcome (paraphrasing is fine if the right feeling/response was produced).

---

## Recent Design Decisions (and the why behind them)

These corrections shaped the current behavior. Future sessions should respect them:

- **Strategic questions are NOT permission-seeking.** The whole script is question-driven. Reward tie-downs, "Would that help?", "Make sense?", engineered-yes questions. Only dock for true outs ("Do you want to join?").
- **Spouse/girlfriend objection** uses Deaf Ear → "if she doesn't join, would you still be interested?" → free-pass-on-account close. Do NOT default to "invite her in for a tour."
- **Assumptive ID collection** is a STATEMENT of forward motion ("Do you have your ID and I can create your profile") — not a question with a hedge.
- **Monthly cost is rarely the real objection.** The upfront (enrollment + first + last) is what scares prospects. The Mike-construction persona closes on Coupon Drop and does NOT pivot to monthly cost. Only consider modeling monthly-cost battles at Hard level if asked.
- **Sit-Down ≠ Fear Removal Script.** The PDF names the opener line "Fear Removal Opener" but the SECTION is just "the sit-down." Do not rename it back.
- **Brand Ambassador Drop is now Google Review Drop.** Same lever, correct name.
- **Payment-timing > Google Review Drop** when the objection is timing. Closes at full price; Google Review Drop waives revenue.
- **Locations canonicalize.** `fox-lake` and `fox-lake-01'` → `fox-lake-01`. Don't fragment leaderboard with historical aliases.
- **70 = passing.** 85+ = excellence. Trend > single score. Category breakdown > total.
- **Scorecards are never deleted.** Every rescore appends a new row. Live analytics dedupe to latest-per-recording.

---

## Future Roadmap (not built yet)

Sketched but deferred:

- **Whisper chunking** for >25 MB audio (one specific 82-minute recording from 4/23 sits in `failed` status waiting for this)
- **Per-rep tracking** — currently we group by location. Adding `rep_name` to the recording flow unlocks per-rep analytics, drift detection, 1:1 prep packets
- **Real auth on /airafitnessclosinggame** — location-email magic link → real player accounts → leaderboard panel scoped to franchise
- **Daily 60-second drill email** — pull a transcript snippet at random, ask the rep what their move would be, reply-to-email captures their answer
- **Pattern-of-the-week alert to VPs** — weekly job: scan past 7 days, find any theme that crossed a threshold, email Monday morning
- **Voice mode for /practice** — Whisper input + ElevenLabs output, full audio simulation
- **Rolling 5-consult average** instead of per-consult flag — stops a single bad day from getting a rep flagged

---

## How to make changes

- **Tune scoring behavior** — edit the SCORING_PROMPT in `ai.js`. Keep the COACHING PHILOSOPHY and QUESTION-LED LEADERSHIP sections intact; they override everything below them.
- **Add a new persona** — append to `PROSPECT_PERSONAS[bucket].scenarios` in `ai.js`. Each scenario needs `id`, `name`, `opening`, `systemPrompt`. To put it in the game, add the `id` to the right level in `GAME_LEVELS`.
- **Add a coaching theme to the dashboard** — append to the `themes` array in the `/admin` route handler (server.js). Each theme has `name` + `patterns` (array of regex).
- **Add a location** — `locations.js`. If you rename an old location, add the old slug to `LOCATION_ALIASES` so historical recordings merge.
- **Tune brand colors** — `email.js` constants at the top. Mirror in `server.js` for the admin/scorecard/game pages.
- **Change passing threshold** — `FLAG_SCORE_THRESHOLD` env var; UI thresholds (70/85) are inline in email.js + server.js admin pages.

---

_Last updated 2026-04-30 after the Closing Game launch and the Mike-construction persona fix._
