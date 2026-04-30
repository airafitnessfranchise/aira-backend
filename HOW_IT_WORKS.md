# Aira Fitness — How the Coaching System Works

A guide for Mike and the VP team. Covers what the platform does, how to use it, and what every screen and number means.

---

## What we built

We have three connected products. They share one database and one scoring brain — so a rep practicing in the game uses the same coaching engine that grades their real consults.

| Product                      | What it does                                                           | Who uses it                 |
| ---------------------------- | ---------------------------------------------------------------------- | --------------------------- |
| **Consult Scorecard System** | Tablet records the consult → scores it → emails a coaching scorecard   | Franchisees + you + VPs     |
| **Practice Bot**             | Mock consults against an AI prospect, no game mechanics                | Franchisees (open practice) |
| **Closing Game**             | Gamified leveled progression — 5 levels, 11 prospects, XP, leaderboard | Franchisees (training)      |

---

## Quick reference

| Where                         | What                                                                      | Login                                    |
| ----------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| **`/admin`**                  | Your dashboard — every consult, every gym, every recurring mistake        | username `admin`, password `airafitness` |
| **`/admin/library`**          | Real consult pairs — closed example next to no-sale example, by objection | same login                               |
| **`/admin/locations`**        | Add new gyms (also page to manage existing ones)                          | same login                               |
| **`/practice`**               | Practice tool for franchisees                                             | open, no login                           |
| **`/airafitnessclosinggame`** | The game                                                                  | open, no login                           |

Full base URL: `https://aira-backend-production-2a71.up.railway.app`

---

## The Consult Scorecard System

The franchisee runs a real consult on the floor. The tablet records it. Within a couple minutes after they end the recording, an email lands in their inbox (and yours, and the VP's) with a full scorecard.

**What gets emailed:**

- Overall score 0-100, color-coded
- "Sale Closed" or "No Sale" badge
- A 2-sentence summary of the consult
- Four category bars (Sit-Down, Objection Handling, Language & Psychology, Close Execution) with a 1-2 sentence "why this score" line under each
- A coaching narrative — written in your voice, specific to what they said, with quotes from the actual transcript
- A button to play back the audio (link expires in 7 days)
- The full transcript at the bottom

**Where the data goes:** every scorecard is saved permanently in the database. It powers the dashboard, the library, the themes panel, and any future training tools we build. We never delete a scorecard — even if a consult gets re-scored after a prompt update, we keep the history.

---

## The Scoring System

Every score is the model grading the rep against the **5-Day Training material**. It's evaluating four categories, each worth 25 points:

### Sit-Down Presentation (0-25)

Did the rep deliver the five-component sit-down BEFORE the price sheet got flipped?

1. Month-to-month
2. No contracts / cancel anytime
3. First + last + enrollment fee
4. "Like every other gym" framing
5. "Make sense?" close

Plus: were all 3 tiers presented? Did they stay seated? Was the assumptive close used?

### Objection Handling (0-25)

- Did they run the **Deaf Ear Close** on the first objection BEFORE offering anything?
- Did they isolate the real objection with a question (not an assumption) before pulling out a tool?
- If cost was the issue, did they offer the **Coupon Drop** correctly?
- If timing was the issue (payday), did they try a **payment-timing solution** (post-date, split billing) BEFORE going to the Google Review Drop? Payment-timing closes at full price — that's the better outcome.
- Was the **Google Review Drop** used only as last resort?

### Language & Psychology (0-25)

The Aira approach is question-led leadership. Strategic questions are good — they're the technique:

- Tie-downs ("Did you like the gym?")
- Engineered-yes questions ("Would that help you out?", "Is that fair?")
- "Make sense?" check-ins
- "Would you like me to grab that for you?" once cost is on the table

What gets docked: TRUE permission-seeking — questions that hand the prospect a no-button. "Do you want to join?" "Are you ready?" "What do you think?" after pricing. These are exits, not leads.

### Close Execution (0-25)

- Was the assumptive close attempted? ("Which one would you like to get started with today?")
- After the prospect picked a tier, did the rep ASSUME the sale at ID collection? "Do you have your ID and I can create your profile" — statement of forward motion, not a question with a hedge.
- Was the close re-attempted after objections without skipping sequence?
- After the close: was PIF offered? Were referrals collected?

### What the score means

| Score     | Meaning                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| **85+**   | Excellence. They've internalized the psychology. This is the bar for "expert closer."    |
| **70-84** | Solid. The fundamentals are there. The coaching note will name 1-2 specific refinements. |
| **<70**   | Structural moves are missing. Coaching call territory — they need targeted training.     |

**70 is the operational passing line.** Anything below 70 gets flagged for review automatically.

A few things worth holding onto when interpreting scores:

1. **Trend > single score.** A 65 once is fine; a 65 ten consults in a row needs intervention. The 30-day sparkline on the dashboard is the right lens.
2. **Closing > score.** A rep with a 60 who closed at full price made you more money than an 85 who didn't close.
3. **Category breakdown > total.** A 75 with bars at 23/23/17/12 has a Close Execution problem. A 75 with bars at 18/19/19/19 has no specific gap. Same total, totally different coaching.

---

## The Closing Game

`/airafitnessclosinggame` — the franchisee-facing training game.

### How it works

A rep enters their name and gym, then sees a level map. Five levels, each with one or more prospect personas. Click a level → click a prospect → role-play a mock consult. End the consult, get scored. Pass the level (close the sale AND score 70+) to unlock the next.

### The 5 Levels

#### **Level 1 — Rookie** (color: cyan)

_"Welcome to the Floor"_
Your first prospect just walked in. Master the basics.

- **Sarah** — 32-year-old new mom, walked in on impulse, 80% sold before you opened your mouth. Tests: can you handle a basic consult without screwing it up? If you can't close Sarah, you can't close anyone.

#### **Level 2 — Street Smart** (color: cyan)

_"Different Kinds of Easy"_
Not every easy prospect closes the same way. Read the room.

- **Marcus** — 45, recently divorced, signing up for himself. ONE soft objection: he's contract-skeptical because his last gym locked him in. If you say "month-to-month, no contracts, cancel anytime," his guard drops fast.
- **Tasha** — 26, ultra runner, looking for indoor cross-training. Money is no issue. She just wants to feel like the rep took her equipment questions seriously.

#### **Level 3 — Deaf Ear** (color: blue)

_"When 'Let Me Think' Means Cost"_
Run the diagnostic. Find the real objection. Match the tool. **This is the most important level — every objection in the field starts here.**

- **Mike** — 38, construction worker, money is tight, says "let me think about it." If you accept the walkaway, he's gone. If you run the Deaf Ear and surface that cost is the issue, the Coupon Drop closes him. Don't pivot to monthly cost — that's not his issue.
- **Brandon** — 41, mortgage + 2 kids in sports, openly comparing gyms. His objection is value — does this gym justify the cost? Run the Deaf Ear, get him saying yes to the gym before pricing comes up, and the Coupon Drop closes him.

#### **Level 4 — Negotiator** (color: violet)

_"Creative Closes at Full Price"_
The expensive levers (Google Review Drop) waive real revenue. The expert moves close at full price.

- **Daniela** — 34, single mom of two, payday is Friday. Genuine timing issue, not "let me think." If you accept "come back Friday," she's gone (life with two kids will take over). If you offer a payment-timing solution (post-date the billing to Friday, split the enrollment), she closes at full price — happily.
- **Stephanie** — 28, gym-quitter, openly admits she's joined and quit four gyms. Her objection isn't cost or contracts — it's accountability. She doesn't trust HERSELF to keep showing up. The close that works: ask what would help her stick with it (group classes? trainer? schedule?) BEFORE doing pricing. Cost is not her issue.

#### **Level 5 — Boss** (color: pink)

_"The Toughest Closes"_
Stacked objections. Skepticism. Intimidation. Business credibility. Earn your stripes.

- **Jessica** — 29, marketing manager, already toured Planet Fitness ($10/mo) and LA Fitness. Stacked objections: price → payday → spouse. Will only close if you DON'T lead with a discount, run the full Deaf Ear, isolate cost with a question, then offer either Coupon + payment-timing OR Coupon → Google Review Drop. Stay calm. Never argue.
- **Carlos** — 52, has tried 3 gyms in 2 years. Deeply skeptical. If you treat him like a generic prospect (script lines without acknowledging his specific concerns), he walks. The close that works: ASK what went wrong at the previous gyms before pitching anything.
- **Megan** — 31, brand new to fitness, terrified of being judged. She HIDES this fear under "I want to talk to my husband first." That's cover. Even if you run the Deaf Ear and get her past the spouse objection, she'll walk if you don't surface the real fear. The close that works: notice the hesitation, ASK something like "what would make you feel comfortable here?" — surface the intimidation, mention starter resources (beginner classes, free orientation).
- **Trent** — 38, business owner. Tests credibility with sharp questions ("how long have you been in business at this location?", "what separates this from LA Fitness?"). Don't get defensive. Answer with confidence and specifics. Eventually pivot the conversation back to his needs with a Deaf Ear-style question. If you fumble (clichés, defensive answers, scripted-sounding pivots), he walks politely.

### How XP and progression work

- **Pass a scenario:** close the sale + score 70+
- **Pass a level:** pass at least one scenario in that level
- **XP:** sum of total_scores from passing closes (so a perfect 95 close earns 95 XP)
- **Identity:** the game uses a cookie on the rep's browser. Same browser = same player. No login. Different browser/device = fresh player.
- **Leaderboard** (queryable via API today, will be a panel later): top 25 by total XP across all players

The game and the practice bot share the same persona library — the difference is the game tracks progression and gates levels, while practice is open-ended (pick any difficulty, no progression).

---

## The Dashboard (`/admin`)

Auto-refreshes every 30 seconds. Top to bottom:

### KPI cards (6 of them)

- **Recordings** — total real consults recorded
- **Scorecards** — total scored consults (latest version per recording, with a "X total in history" footnote since rescores never delete)
- **Total Closes** — how many consults ended in a paid sale
- **Close Rate** — closes ÷ scorecards. Color-coded (blue if 30%+, dark blue 15-29%, red <15%). Has a 30-day sparkline so you can see if it's trending up or down.
- **Avg Score** — average total_score across scorecards. Color-coded same way. Sparkline.
- **Tablets Online** — how many recording tablets are currently connected to the backend

### Per-Location Leaderboard

Every gym with at least one recording, sorted **weakest avg score first** so the systemic gap is at the top. Columns: Consults, Closes, Close %, Avg Score, Last Activity. This is where you find the location that needs help.

### Average Score by Category

The four bars (Sit-Down, Objection, Language, Close), averaged across all consults, sorted weakest first. This tells you what to train on across the franchise. If Objection Handling is the lowest bar, you've got a Deaf Ear problem at scale.

### Top Coaching Themes

The model has been tagging recurring mistakes across every consult. This panel scans them and shows the top 8 by frequency. You'll see things like:

- "Permission-seeking instead of assumptive close"
- "Accepted 'let me think about it' without re-closing"
- "Skipped 'Make sense?' close on sit-down"
- "Used Google Review Drop too early"
- "Didn't offer PIF after close"

Severity is color-coded by % of consults exhibiting it. This is your "what to teach this month" list.

### All Recordings

The full table — every consult, every status pill, every score. Click a score pill to see the full scorecard. Click "▶ Play" to hear the audio.

---

## The Training Library (`/admin/library`)

Real consult pairs grouped by prospect objection. For each common objection (think about it, talk to spouse, can't afford it, try it first, come back later, just looking, payday), you see:

- **Up to 2 closed examples** (highest-scoring) where the rep handled the objection well
- **Up to 2 no-sale examples** (lowest-scoring) where the rep let it slip away

Click any card to see the full transcript and coaching note. Use this with VPs in training — read the closed example, read the no-sale example, ask the trainee what changed between them.

---

## Common Tasks

### Add a new gym

Go to **`/admin/locations`** (linked from the `/admin` subheader). The page has two parts:

**1) An add-a-gym form at the top.** Fill in:

| Field                | Required? | Notes                                                                                                                                      |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Location ID**      | yes       | Short URL-safe slug like `naples-01` (lowercase letters, numbers, and hyphens only). Used internally to tag every recording from this gym. |
| **Franchise Name**   | yes       | Display name like "Aira Fitness Naples." Shows on emails, dashboards, dropdowns.                                                           |
| **Franchisee Name**  | no        | Owner's name. Used in email greetings. If blank, the greeting falls back to "Hi Aira Fitness Naples Team,"                                 |
| **Franchisee Email** | yes       | Primary recipient for every scorecard email from this gym.                                                                                 |
| **VP Email**         | no        | Optional. Gets cc'd on every scorecard from this gym.                                                                                      |
| **Club Email**       | no        | Optional. Additional copy.                                                                                                                 |
| **GHL Calendar ID**  | no        | Optional. Used by the GHL webhook integration (currently disabled — leave blank if unsure).                                                |

Click **Add Gym**. The new gym goes live **everywhere immediately, no restart needed**:

- Scorecard emails route to the right addresses (franchisee + VP if set + Mike)
- The gym shows up in the `/admin` per-location leaderboard
- The gym shows up in the `/practice` "Your Gym" dropdown
- The gym shows up in the `/airafitnessclosinggame` splash dropdown
- Tablet recordings tagged with this `location_id` resolve correctly

**2) A list of every gym** (built-in + custom) below the form. Each row shows the franchise name + slug, franchisee name, franchisee email, VP email, and a type pill:

- **Built-in** — gyms hardcoded in `locations.js` (Fox Lake, Mishawaka). These can't be deleted from the UI; they live in code. If you ever need one removed, ask Claude.
- **Custom** — gyms added via this page. Each has a **Delete** button. Click it (with confirmation) and the gym is removed from the database and from the in-memory cache instantly.

**A note on edits:** the page currently has Add + Delete but no Edit. To change a custom gym's email, just delete and re-add — re-adding with the same Location ID overwrites the previous record. The historical recordings tied to that ID stay attached to the (re-added) gym.

**A note on slugs:** the Location ID can't collide with a built-in. If you try to use `fox-lake-01`, the form will refuse and show an error. Pick something else.

### Re-score a consult

If a prompt change happened and you want to re-score an older consult to see the new coaching, you have two options:

1. **Self-service via API** (the way I do it from a terminal): `POST /admin/rescore/<recording_id>?test_only=1` with the `X-Admin-Key` header. The `test_only=1` flag sends the email only to Mike — won't spam the franchisee.
2. **Ask Claude** (in a session) to run it.

### Send a test scorecard to yourself

Use the rescore endpoint above with `test_only=1` — it bypasses the franchisee/VP recipients and only emails `mikebell@airafitness.com`.

### Find which franchisees are practicing

Every practice and game session lands in your inbox with the rep's name + gym + score. Filter on subject line "Practice" in your email. Or query the database (we'll build a dashboard panel for this when ready).

---

## Glossary (so we're all using the same language)

| Term                                                         | Meaning                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The Sit-Down**                                             | The opening pricing explanation — month-to-month / no contracts / first + last + enrollment / like every other gym / "Make sense?"                                                                                                                       |
| **Fear Removal Opener**                                      | The specific opening line within the sit-down. The PDF names it. The whole section is just "the sit-down" though, not "the Fear Removal Script."                                                                                                         |
| **The Deaf Ear Close**                                       | "I totally understand. Did you like the gym? Does it have everything? Is it more about the upfront costs?" Run on every objection BEFORE offering anything.                                                                                              |
| **Coupon Drop**                                              | "Did you get our coupon mailer? It discounted the enrollment 50%. Would that help?" Used only after Deaf Ear isolates cost.                                                                                                                              |
| **Google Review Drop**                                       | The last-resort lever. Waives enrollment in exchange for a 5-star review + referrals. Only after coupon is declined AND no payment-timing works. (Used to be called "Brand Ambassador Drop" — same thing, correct name now.)                             |
| **Payment-timing solution**                                  | Post-date the billing to next payday, split the enrollment, or charge first month today + defer the rest. Closes at FULL PRICE — better outcome than the Google Review Drop.                                                                             |
| **The Assumptive Close**                                     | "Which one would you like to get started with today?" — assumes the sale, asks only which tier. NEVER "Do you want to join?"                                                                                                                             |
| **Tie-downs**                                                | Locking-in questions when buying signals appear: "Do you like it?", "Does it have everything you need?", "Is there any reason you couldn't get started today?"                                                                                           |
| **By The Way Close**                                         | At end of free pass visit: "Would you rather save the enrollment fee today or pay the full amount later?"                                                                                                                                                |
| **PIF**                                                      | Paid In Full — "If you pay for the full year today, I can give you 20% off and 2 months free." Offered AFTER the close, not as a way to close.                                                                                                           |
| **The Free Pass Sequence**                                   | When a prospect asks to try first: collect ALL info, sign agreements, THEN mention the $25 activation. NOT a hard sale — service them, then By The Way at the end.                                                                                       |
| **The Strategic Question vs Permission-Seeking distinction** | Strategic questions lead the prospect through stacked yeses ("Would that help you out?" once they've admitted cost is the issue). Permission-seeking gives them an out where forward motion was the move. The model rewards the first, docks the second. |

---

## What to do this week

1. **Walk through the dashboard** with each VP. Show them the leaderboard (whose gym needs help), the themes panel (what to train on), and the library (real examples to use in coaching).
2. **Have every franchisee try the game** — Level 1 first. They should get to at least Level 3 in their first sitting. The data will tell us who's actually engaging.
3. **Run the practice bot during your weekly call.** Pick a Hard prospect (Carlos or Megan), have a franchisee role-play it live, and discuss the scorecard together.
4. **Review one flagged consult per VP per week.** Anything with a `flagged_for_review` tag below 70 — listen to the audio, read the transcript, decide if it's a one-off or a pattern.

---

## Who to ask when

- **Tablet not recording / consult missing from dashboard** → check Tablets Online card on /admin. If the gym is offline, the franchisee needs to reconnect the tablet to wifi.
- **Score feels wrong** → tell me which consult and what specifically feels off. The scoring prompt is tunable. Every correction Mike has made over the last few sessions has been incorporated.
- **Want a new persona / level / feature** → ask. We can iterate fast on this stuff.
- **Lost the admin password** → the password is `airafitness`. Reach out if you ever want to change it.

---

_This document covers the system as of April 30, 2026. As we add features (real player accounts, voice mode, weekly digest emails, per-rep tracking), this will get updated._
