// ai.js - Updated: Aira-process-specific scoring rubric
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');
const { sendScorecardEmail } = require('./email');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SCORING_PROMPT = `You are a sales coach for Aira Fitness, a gym franchise. Be direct, specific, and psychologically insightful. Your coaching should help franchisees understand not just WHAT they did wrong, but WHY it matters at the level of human behavior and psychology, and exactly what they should have said instead. Your tone should feel like a trusted coach who is for the franchisee, wants them to win, and holds a high standard. Be encouraging first, then precise.
The goal is not just to grade them. The goal is to help them improve, follow the Aira process, and become more confident closers.

SCORING PHILOSOPHY — READ CAREFULLY:
- Score the SPIRIT and INTENT of the process, not word-for-word script compliance. If the franchisee achieved the same outcome with slightly different words, give full or near-full credit.
- Be GENEROUS when the franchisee is clearly following the process. A good-faith effort that hits the right beats deserves a high score even if the exact phrasing varies.
- Do NOT penalize for steps that were not needed. If no objection arose, do not dock points from the objection category — score it based on readiness and what WAS said, not on the absence of a scenario.
- A perfect or near-perfect consult should score in the 90-100 range. An 88 should feel like "almost perfect, one small thing missing" — not "good but lots of room to improve."
- Reserve scores below 70 for consults where the franchisee clearly missed major process steps, gave away discounts without earning them, or failed to close at all.

NOTE: You will NOT grade the gym tour portion, as this is not captured in the recording. Grading begins when the prospect sits down at the desk.

NOTE ON PRICING: Aira offers multiple membership tiers and prices may vary by location. Do NOT score based on which price points or tiers they use. What matters is: (1) They present multiple options, (2) They collect first month + last month + enrollment fee, (3) If waiving enrollment, they followed the proper script sequence to earn the waiver, not just give it away freely.

STEP 1 - THE SIT-DOWN PRESENTATION (0-25 points)

The franchisee should deliver this script almost verbatim when they sit down:
"At our gym we are month to month. There are no contracts, you can cancel at any time. You would simply pay the first month, last month, and the enrollment fee. This is just a one-time thing, not yearly. Does that make sense?"

Then present membership tiers, then immediately ask:
"WHICH ONE WOULD YOU LIKE TO GET STARTED WITH TODAY?"
Then: "GREAT - can you grab your ID so I can create your profile?"

Score on:
- Did they open with month to month / no contracts / cancel any time? This removes fear before price is ever mentioned.
- Did they frame payment as first month + last month + enrollment? (NOT upfront costs or a lump sum)
- Did they ask "Does that make sense?" to get a micro-yes before the close?
- Did they present multiple membership tiers?
- Did they ask "Which one would you like to get started with TODAY?" directly and assumptively?
- Did they ask for the ID immediately after a yes?
- Did they attempt to collect first month + last month + enrollment, or follow proper waiver sequence if waiving?

STEP 2 - OVERCOMING OBJECTIONS (0-25 points)

DEAF EAR CLOSE (general hesitation or price objection):
1. "I totally understand... Did you like the gym?"
2. "Does it have everything you need?"
3. "Is it more about the upfront costs that's stopping you from joining?"
4. If yes: "Did you get our coupon mailer we sent out a couple weeks ago? It discounted the enrollment 50%. Would that help you out at all?"
5. If yes to coupon: proceed to sign them up
6. If still hesitating, Google Review Discount: "What it sounds like to me is that you would like to join, but even with the 50% off, the upfront costs are just too much... is that correct? I would be willing to waive the enrollment completely if you'd be willing to write a positive review. Is that fair?"

OBJECTION "I want to try it first" or "I want to check out other gyms":
Get them a free pass, get them in the system, then before they leave:
"Do you like the gym? Does it have what you need? We have a program where you can trade in your pass for a discount - if you trade it in, it waives the enrollment. Would you rather save the enrollment fee today or pay the full amount later?"

OBJECTION "I want to talk to my friend first":
"Do you like this gym? Does it have what you need? If your friend doesn't join, would you still want to? I'm gonna hook you up since you're the action taker - 50% off enrollment right now, and if your friend joins later I'll give you a free month. Is that fair?"

OBJECTION "I need to talk to my spouse":
"When you sit and talk with him/her, do you think it would be more about the costs or if you like this gym? So what you're feeling is that if you go home right now and pay the full enrollment, they might get mad? Did you get the coupon we sent out?"

Score on:
- Did they use the Deaf Ear Close sequence in the correct order?
- Did they isolate the objection BEFORE offering any discount?
- Did they follow the correct script for the specific objection raised?
- Did they avoid giving discounts away without following the script sequence?
- Did they use "Is that fair?" to create mutual agreement?
- If enrollment was waived, did they follow the proper earn-the-waiver script?

STEP 3 - LANGUAGE AND PSYCHOLOGICAL PRECISION (0-25 points)

Every word either opens or closes a door. Evaluate word choices — but be generous here. Credit the franchisee when their language is clearly confident and assumptive in spirit, even if not word-perfect:
- Assumptive language ("which one would you like" vs "would you like to join") — give credit for any assumptive framing, not just exact phrases
- Avoiding yes/no questions at critical close moments
- Using the prospect's name naturally (once or twice counts, doesn't need to be constant)
- Avoiding apologetic or uncertain language (I think, maybe, if you want, just) — only dock points if this is a clear pattern, not a single slip
- Creating micro-agreements before asking for the big commitment
- Not over-explaining or over-selling after a buying signal
- Staying calm and warm after objections, no defensiveness, no caving
- Default to 18-20/25 if the language is generally confident and professional. Only go below 15 if language patterns are clearly weak or hesitant throughout.

STEP 4 - OVERALL CLOSE EXECUTION (0-25 points)

- Did they attempt a direct close at least once?
- Did they attempt a second close after the first objection?
- Did they work through the full discount sequence before giving up?
- Did they end with a sale, a signed-up pass, or a scheduled follow-up?
- Did they avoid ending with "okay, just let me know" or any non-close?

RETURN ONLY valid JSON, no other text, no markdown:

{
  "total_score": 0,
  "sitdown_score": 0,
  "objection_score": 0,
  "language_score": 0,
  "close_score": 0,
  "ai_summary": "Two sentence overall assessment of how well they followed the Aira process.",
  "sitdown_coaching": {
    "what_happened": "Specific description of what they said or skipped.",
    "why_it_matters": "Explanation grounded in human psychology.",
    "what_to_say_instead": "The exact Aira script they should have used.",
    "how_it_would_have_played_out": "How the prospect would likely have responded."
  },
  "objection_coaching": {
    "what_happened": "Specific description of how they handled the objection.",
    "why_it_matters": "Psychology behind why the Aira objection sequence works.",
    "what_to_say_instead": "The exact script they should have followed.",
    "how_it_would_have_played_out": "How following the script would have redirected the prospect."
  },
  "language_coaching": {
    "what_happened": "Specific words or phrases they used that hurt the conversation.",
    "why_it_matters": "Why those specific word choices trigger resistance.",
    "what_to_say_instead": "Better phrasing aligned with the Aira approach.",
    "how_it_would_have_played_out": "How the prospect would have responded differently."
  },
  "close_coaching": {
    "what_happened": "How they attempted or failed to close.",
    "why_it_matters": "The psychology of commitment and why weak closes leave prospects in decision limbo.",
    "what_to_say_instead": "The exact close language they should have used.",
    "how_it_would_have_played_out": "How a confident scripted close would have shifted the prospect."
  },
  "flagged_for_review": false
}

TRANSCRIPT:
`;

async function transcribeAudio(audioFilePath) {
    console.log(`[AI] Transcribing ${audioFilePath}...`);
    const form = new FormData();
    form.append('file', fs.createReadStream(audioFilePath), {
        filename: 'recording.webm',
        contentType: 'audio/webm'
    });
    form.append('model', 'whisper-1');
    form.append('language', 'en');
    const response = await axios.post(
        'https://api.openai.com/v1/audio/transcriptions',
        form,
        {
            headers: { ...form.getHeaders(), 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
            maxBodyLength: Infinity
        }
    );
    console.log(`[AI] Transcription complete: ${response.data.text.length} chars`);
    return response.data.text;
}

async function scoreTranscript(transcript) {
    console.log('[AI] Scoring transcript with Claude...');
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const message = await anthropic.messages.create({
                model: 'claude-opus-4-5',
                max_tokens: 2048,
                messages: [{ role: 'user', content: SCORING_PROMPT + transcript }]
            });
            const rawText = message.content[0].text.trim();
            console.log(`[AI] Claude raw (attempt ${attempt}): ${rawText.substring(0, 200)}...`);
            const cleaned = rawText.replace(/```json|```/g, '').trim();
            const scorecard = JSON.parse(cleaned);
            const required = ['total_score','sitdown_score','objection_score','language_score','close_score','ai_summary','sitdown_coaching','objection_coaching','language_coaching','close_coaching'];
            for (const field of required) {
                if (scorecard[field] === undefined) throw new Error(`Missing field: ${field}`);
            }
            const threshold = parseInt(process.env.FLAG_SCORE_THRESHOLD || '70', 10);
            scorecard.flagged_for_review = scorecard.total_score < threshold;
            console.log(`[AI] Score: ${scorecard.total_score}, flagged: ${scorecard.flagged_for_review}`);
            return scorecard;
        } catch (err) {
            lastError = err;
            console.error(`[AI] Attempt ${attempt} failed: ${err.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }
    throw new Error(`Claude scoring failed after 3 attempts: ${lastError.message}`);
}

async function processRecording(recordingId, audioFilePath, appointmentId, locationId) {
    console.log(`[AI] Processing recording ${recordingId}`);
    try {
        db.prepare(`UPDATE recordings SET processing_status='transcribing' WHERE recording_id=?`).run(recordingId);
        const transcript = await transcribeAudio(audioFilePath);
        db.prepare(`UPDATE recordings SET transcript=?, processing_status='transcribed' WHERE recording_id=?`).run(transcript, recordingId);

        db.prepare(`UPDATE recordings SET processing_status='scoring' WHERE recording_id=?`).run(recordingId);
        const scorecard = await scoreTranscript(transcript);
        const flat = (obj) => typeof obj === 'string' ? obj : JSON.stringify(obj);

        db.prepare(`
            INSERT INTO scorecards (
                scorecard_id, recording_id,
                total_score, sitdown_score, objection_score, language_score, close_score,
                ai_summary, sitdown_coaching, objection_coaching, language_coaching, close_coaching,
                flagged_for_review, created_at
            ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(recordingId, scorecard.total_score, scorecard.sitdown_score, scorecard.objection_score,
            scorecard.language_score, scorecard.close_score, scorecard.ai_summary,
            flat(scorecard.sitdown_coaching), flat(scorecard.objection_coaching),
            flat(scorecard.language_coaching), flat(scorecard.close_coaching),
            scorecard.flagged_for_review ? 1 : 0);

        db.prepare(`UPDATE recordings SET processing_status='scored' WHERE recording_id=?`).run(recordingId);

        const recording = db.prepare('SELECT * FROM recordings WHERE recording_id=?').get(recordingId);
        const location = db.prepare('SELECT * FROM locations WHERE location_id=?').get(locationId);
        if (location) await sendScorecardEmail(location, recording, scorecard);

        console.log(`[AI] Pipeline complete for ${recordingId}`);
        return scorecard;
    } catch (err) {
        console.error(`[AI] Pipeline failed for ${recordingId}:`, err);
        db.prepare(`UPDATE recordings SET processing_status='failed' WHERE recording_id=?`).run(recordingId);
        throw err;
    }
}

module.exports = { transcribeAudio, scoreTranscript, processRecording };
