// email.js
// ─────────────────────────────────────────────────────────
// Sends scorecard emails via Resend.com
// ─────────────────────────────────────────────────────────

const axios = require('axios');

function scoreBar(score, max) {
  const filled = Math.round((score / max) * 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function gradeColor(score) {
  if (score >= 80) return '#22c55e';
  if (score >= 70) return '#f59e0b';
  return '#ef4444';
}

async function sendScorecardEmail({ to, franchisee_name, date, scorecard, appointment_id }) {
  const grade = scorecard.total_score >= 80 ? 'Good' : scorecard.total_score >= 70 ? 'Needs Work' : 'Action Required';
  const color = gradeColor(scorecard.total_score);

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px;">

  <div style="background: #111; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: #c8f060; margin: 0; font-size: 22px; letter-spacing: 2px;">AIRA FITNESS</h1>
    <p style="color: #888; margin: 4px 0 0; font-size: 13px; letter-spacing: 1px;">CONSULTATION SCORECARD</p>
  </div>

  <div style="background: white; padding: 32px; border-radius: 0 0 12px 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">

    <p style="color: #555; margin: 0 0 24px;">Hi ${franchisee_name},<br><br>
    Here is your consultation scorecard for <strong>${date}</strong>.<br>
    Appointment ID: <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px;">${appointment_id}</code></p>

    <!-- Overall Score -->
    <div style="text-align: center; background: #f8f8f8; border-radius: 12px; padding: 24px; margin-bottom: 28px; border: 2px solid ${color};">
      <div style="font-size: 56px; font-weight: bold; color: ${color}; line-height: 1;">${scorecard.total_score}</div>
      <div style="color: #888; font-size: 14px; margin-top: 4px;">OUT OF 100</div>
      <div style="display: inline-block; background: ${color}; color: white; padding: 4px 16px; border-radius: 20px; font-size: 13px; font-weight: bold; margin-top: 8px;">${grade}</div>
    </div>

    <!-- Category Scores -->
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 28px;">
      <tr style="background: #f0f0f0;">
        <th style="padding: 10px 12px; text-align: left; font-size: 12px; color: #888; letter-spacing: 1px; text-transform: uppercase;">Category</th>
        <th style="padding: 10px 12px; text-align: right; font-size: 12px; color: #888; letter-spacing: 1px; text-transform: uppercase;">Score</th>
      </tr>
      <tr style="border-bottom: 1px solid #f0f0f0;">
        <td style="padding: 12px;">Rapport</td>
        <td style="padding: 12px; text-align: right; font-weight: bold; color: ${gradeColor(scorecard.rapport_score * 5)};">${scorecard.rapport_score} / 20</td>
      </tr>
      <tr style="border-bottom: 1px solid #f0f0f0; background: #fafafa;">
        <td style="padding: 12px;">Presentation</td>
        <td style="padding: 12px; text-align: right; font-weight: bold; color: ${gradeColor(scorecard.presentation_score * 5)};">${scorecard.presentation_score} / 20</td>
      </tr>
      <tr style="border-bottom: 1px solid #f0f0f0;">
        <td style="padding: 12px;">Objection Handling</td>
        <td style="padding: 12px; text-align: right; font-weight: bold; color: ${gradeColor(scorecard.objection_handling_score * 5)};">${scorecard.objection_handling_score} / 20</td>
      </tr>
      <tr style="border-bottom: 1px solid #f0f0f0; background: #fafafa;">
        <td style="padding: 12px;">The Close</td>
        <td style="padding: 12px; text-align: right; font-weight: bold; color: ${gradeColor(scorecard.close_attempt_score * 5)};">${scorecard.close_attempt_score} / 20</td>
      </tr>
      <tr>
        <td style="padding: 12px;">Follow Up</td>
        <td style="padding: 12px; text-align: right; font-weight: bold; color: ${gradeColor(scorecard.followup_score * 5)};">${scorecard.followup_score} / 20</td>
      </tr>
    </table>

    <!-- AI Summary -->
    <div style="background: #f0f7ff; border-left: 4px solid #3b82f6; padding: 16px; border-radius: 0 8px 8px 0; margin-bottom: 24px;">
      <p style="margin: 0; font-size: 14px; color: #1e40af; font-weight: bold; margin-bottom: 6px;">AI SUMMARY</p>
      <p style="margin: 0; color: #334155; font-size: 14px; line-height: 1.6;">${scorecard.ai_summary}</p>
    </div>

    <!-- Coaching Notes -->
    <h3 style="color: #111; font-size: 14px; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 16px;">Coaching Notes</h3>

    ${[
      { label: 'Rapport', note: scorecard.rapport_coaching },
      { label: 'Presentation', note: scorecard.presentation_coaching },
      { label: 'Objection Handling', note: scorecard.objection_coaching },
      { label: 'The Close', note: scorecard.close_coaching },
      { label: 'Follow Up', note: scorecard.followup_coaching }
    ].map(({ label, note }) => `
    <div style="margin-bottom: 16px; padding: 14px; background: #fafafa; border-radius: 8px; border: 1px solid #e5e5e5;">
      <p style="margin: 0 0 6px; font-weight: bold; color: #111; font-size: 13px;">${label}</p>
      <p style="margin: 0; color: #555; font-size: 13px; line-height: 1.6;">${note}</p>
    </div>`).join('')}

    <hr style="border: none; border-top: 1px solid #eee; margin: 28px 0;">
    <p style="color: #888; font-size: 13px; text-align: center; margin: 0;">
      Keep working the process — the scores will follow.<br>
      <strong style="color: #111;">Aira Fitness</strong>
    </p>

  </div>
</body>
</html>`;

  await axios.post(
    'https://api.resend.com/emails',
    {
      from: process.env.EMAIL_FROM,
      to: [to],
      subject: `Consult Score — ${franchisee_name} — ${date} — ${scorecard.total_score}/100`,
      html
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  console.log(`[Email] Scorecard sent to ${to}`);
}

module.exports = { sendScorecardEmail };
