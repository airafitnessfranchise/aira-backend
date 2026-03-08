// ai.js
// ─────────────────────────────────────────────────────────
// Handles transcription (Whisper) and scoring (Claude)
// ─────────────────────────────────────────────────────────

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

// ─── Transcribe audio with OpenAI Whisper ─────────────────

async function transcribeAudio(audioFilePath)  {
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
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        ...form.getHeaders()
      },
      maxBodyLength: Infinity
    }
  );

  console.log(`[AI] Transcription complete — ${response.data.text.length} chars`);
  return response.data.text;
}

// ─── Score transcript with Claude ─────────────────────────

async function scoreTranscript(transcript) {
  console.log(`[AI] Scoring transcript with Claude...`);

  const prompt = `You are a sales coach for Aira Fitness, a gym franchise.
Evaluate the following sales consultation transcript against the Aira sales process.
Be honest and specific. Quote the transcript when giving coaching notes.

Score each category from 0 to 20:

RAPPORT (0-20)
- Did they ask about the prospect's fitness goals?
- Did they learn and use the prospect's name?
- Did they make the prospect feel welcome and comfortable?

PRESENTATION (0-20)
- Did they present all 3 membership tiers?
- Did they explain value, not just price?
- Did they highlight key differentiators of Aira?

OBJECTION HANDLING (0-20)
- Did they address price objections by reinforcing value?
- Did they avoid dropping price too quickly?
- Did they use empathy when handling hesitation?

THE CLOSE (0-20)
- Did they directly ask for the sale?
- Did they attempt the close more than once if first declined?
- Did they create urgency or a clear reason to decide today?

FOLLOW UP (0-20)
- Did they set a clear next step if no sale was made?
- Did they collect or confirm contact information?
- Did they explain what happens next?

Return ONLY a valid JSON object in this exact format, no other text:
{
  "total_score": 0,
  "rapport_score": 0,
  "presentation_score": 0,
  "objection_handling_score": 0,
  "close_attempt_score": 0,
  "followup_score": 0,
  "ai_summary": "Two sentence overall assessment.",
  "rapport_coaching": "Specific coaching note with transcript quote.",
  "presentation_coaching": "Specific coaching note with transcript quote.",
  "objection_coaching": "Specific coaching note with transcript quote.",
  "close_coaching": "Specific coaching note with transcript quote.",
  "followup_coaching": "Specific coaching note with transcript quote."
}

TRANSCRIPT:
${transcript}`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    }
  );

  const raw = response.data.content[0].text.trim();

  // Strip any markdown code fences if Claude adds them
  const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
  const scorecard = JSON.parse(cleaned);

  // Make sure total_score is sum of all categories
  scorecard.total_score =
    (scorecard.rapport_score || 0) +
    (scorecard.presentation_score || 0) +
    (scorecard.objection_handling_score || 0) +
    (scorecard.close_attempt_score || 0) +
    (scorecard.followup_score || 0);

  console.log(`[AI] Scoring complete — total: ${scorecard.total_score}/100`);
  return scorecard;
}

module.exports = { transcribeAudio, scoreTranscript };
