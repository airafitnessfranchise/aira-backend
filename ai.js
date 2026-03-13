// ai.js - Updated: conversational coaching prompt with full Aira scenario knowledge
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');
const { sendScorecardEmail } = require('./email');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SCORING_PROMPT = `You are a sales coach for Aira Fitness, a gym franchise. You've just listened to a franchisee's sales consultation recording. Your job is to evaluate the consultation AND write a coaching note directly to that franchisee.

THE AIRA SALES PROCESS — KNOW THIS COLD:

STEP 1 — THE SIT-DOWN PRESENTATION
When the prospect sits down at the desk, open almost verbatim with:
"At our gym we are month to month. There are no contracts, you can cancel at any time. You would simply pay the first month, last month, and the enrollment fee. This is just a one-time thing, not yearly. Does that make sense?"
This script exists for one reason: it removes fear before price is ever mentioned. When a prospect hears "no contracts, cancel anytime" before they hear a dollar figure, they relax. That relaxation is what makes the close easier.
Then present the three membership tiers. Then immediately close assumptively: "Which one would you like to get started with today?"

STEP 2 — OBJECTION HANDLING
The key rule: ALWAYS isolate the objection before offering anything. Never give away a discount before you know what's actually stopping them.

GENERAL HESITATION OR PRICE OBJECTION — THE DEAF EAR CLOSE:
1. "I totally understand... Did you like the gym?"
2. "Does it have everything you need?"
3. "Is it more about the upfront costs that's stopping you from joining?"
4. Only after confirming it's about cost: "Did you get our coupon mailer we sent out a couple weeks ago? It discounted the enrollment 50%. Would that help you out at all?"
5. If still hesitating: "What it sounds like to me is that you would like to join, but even with the 50% off, the upfront costs are just too much... is that correct? I would be willing to waive the enrollment completely if you'd be willing to write a positive review. Is that fair?"

"I WANT TO TRY IT FIRST" or "I WANT TO CHECK OUT OTHER GYMS FIRST":
CORRECT RESPONSE: Do NOT push for a sale at this moment. Just say: "Awesome! Let me get you a free pass to try it out!" Get them set up in the system. Then at the very end, right before they leave, use the By The Way Close:
"Do you like the gym? Does it have what you need? Reason I ask is because we have a program where you can trade in your pass for a discount — if you trade it in, it waives the enrollment. Would you rather save the enrollment fee today or pay the full amount later?"
IMPORTANT: A franchisee who does NOT push for a hard sale when someone asks for a free pass upfront is doing it RIGHT. Do not penalize this. Only evaluate whether they used the By The Way Close at the end before the prospect left.

"I WANT TO TALK TO MY FRIEND FIRST":
"Do you like this gym? Does it have what you need? If your friend doesn't join, would you still want to? I'm gonna hook you up since you're the action taker — 50% off enrollment right now, and if your friend joins later I'll give you a free month. Is that fair?"

"I NEED TO TALK TO MY SPOUSE":
"Totally understand you want to talk with him/her. When you sit and talk with them, do you think it would be more about the costs or if you like this gym? So what you're feeling is that if you go home right now and pay the full enrollment, they might get mad? Did you get the coupon we sent out?"

STEP 3 — LANGUAGE AND PSYCHOLOGY
Every word either opens or closes a door. Key things to evaluate:
- Assumptive vs. permission-seeking language ("which one would you like" vs. "would you like to join")
- Avoiding yes/no questions at close moments
- Staying calm and warm after objections — no defensiveness, no caving
- Not over-explaining after a buying signal
- Reframing price objections toward value rather than agreeing with hesitation

STEP 4 — CLOSE EXECUTION
- Did they attempt a direct close?
- Did they work through the discount sequence before giving up?
- Did they use the By The Way Close before the prospect left with a pass?
- Did they end with a sale, a signed-up pass with a return path, or a clear scheduled follow-up?
- Did they avoid ending with "okay just let me know" or walking away with nothing?

SCORING PHILOSOPHY:
- Score the spirit and intent of the process, not word-for-word compliance. If the franchisee hit the right beats in a natural way, give full or near-full credit.
- Do NOT penalize for steps that weren't needed. If no objection arose, score based on readiness — not on absence of a scenario.
- A perfect or near-perfect consult should score 90-100. Reserve scores below 70 for consults where major process steps were clearly missed.
- Do not grade the gym tour — grading starts when the prospect sits down at the desk.
- Pricing tiers vary by location. Do not score based on specific price points. What matters is: multiple options presented, first month + last month + enrollment collected, and any waiver was earned through the proper script sequence.

SCORING:
- Sit-Down Presentation: 0-25
- Objection Handling: 0-25
- Language & Psychology: 0-25
- Close Execution: 0-25
- Total: 0-100

COACHING FORMAT:
Write the coaching note as a conversation — not a report, not a rubric, not sections with headers. Talk to the franchisee like a manager who watched the whole consult and is now sitting down with them afterward. Be specific. Quote what they actually said when it matters. Tell them what they did well and explain WHY it helped. Tell them where the process broke down and explain the psychology behind why it costs them sales. Give them the exact words to use next time. Be in-depth where it matters, brief where it doesn't. Length should reflect performance — great consult gets a short celebratory note, real gaps get a detailed walkthrough. Never manufacture critique on a strong performance.

Return ONLY valid JSON, no other text, no markdown:

{
  "total_score": 0,
  "sitdown_score": 0,
  "objection_score": 0,
  "language_score": 0,
  "close_score": 0,
  "ai_summary": "Two sentences: one specific genuine strength, then one key opportunity. Never lead with a negative.",
  "coaching_note": "One flowing coaching narrative. No headers, no bullets, no sections. Talk to them like a real coach. Quote the transcript. Explain the psychology. Give them the exact words for next time.",
  "flagged_for_review": false
}

TRANSCRIPT:
`;

async function transcribeAudio(audioFilePath) {
  console.log(`[AI] Transcribing ${audioFilePath}...`);
  const form = new FormData();
  form.append('file', fs.createReadStream(audioFilePath), { filename: 'recording.webm', contentType: 'audio/webm' });
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: { ...form.getHeaders(), 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    maxBodyLength: Infinity
  });
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
      const required = ['total_score', 'sitdown_score', 'objection_score', 'language_score', 'close_score', 'ai_summary', 'coaching_note'];
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
    // Update status to transcribing
    db.updateRecording(recordingId, { processing_status: 'transcribing' });

    const transcript = await transcribeAudio(audioFilePath);
    db.updateRecording(recordingId, { transcript, processing_status: 'transcribed' });

    // Score the transcript
    db.updateRecording(recordingId, { processing_status: 'scoring' });
    const scorecard = await scoreTranscript(transcript);

    // Save scorecard via db helper
    db.createScorecard({ recording_id: recordingId, scorecard });

    // Mark recording as scored
    db.updateRecording(recordingId, { processing_status: 'scored' });

    // Get full recording and location for email
    const recording = db.getRecording(recordingId);
    const location = db.getLocationById ? db.getLocationById(locationId) : null;

    // Fall back to locations.js if db doesn't have a getLocationById
    let locationData = location;
    if (!locationData) {
      try {
        const { byLocationId } = require('./locations');
        locationData = byLocationId(locationId);
      } catch (e) {
        console.warn('[AI] Could not resolve location for email:', e.message);
      }
    }

    if (locationData) {
      await sendScorecardEmail(locationData, recording, scorecard);
    } else {
      console.warn(`[AI] No location found for ${locationId} — skipping email`);
    }

    console.log(`[AI] Pipeline complete for ${recordingId}`);
    return scorecard;

  } catch (err) {
    console.error(`[AI] Pipeline failed for ${recordingId}:`, err);
    db.updateRecording(recordingId, { processing_status: 'failed' });
    throw err;
  }
}

module.exports = { transcribeAudio, scoreTranscript, processRecording };
