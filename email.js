// email.js
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const MIKE_EMAIL = process.env.MIKE_EMAIL || 'mikebell@airafitness.com';

function scoreRowHtml(label, score, max) {
  const pct = Math.round((score / max) * 100);
  const color = pct >= 70 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444';
  return `
    <tr>
      <td style="padding:6px 0;font-size:13px;color:#374151;">${label}</td>
      <td style="padding:6px 0;text-align:right;font-weight:700;color:${color};">${score}/${max}</td>
    </tr>
    <tr>
      <td colspan="2" style="padding:0 0 10px;">
        <div style="background:#e5e7eb;border-radius:9999px;height:5px;">
          <div style="background:${color};width:${pct}%;height:5px;border-radius:9999px;"></div>
        </div>
      </td>
    </tr>`;
}

async function sendScorecardEmail(location, recording, scorecard, audioUrl) {
  const date = new Date(recording.recorded_at).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const dateShort = new Date(recording.recorded_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });

  const scoreColor = scorecard.total_score >= 70 ? '#22c55e' : scorecard.total_score >= 50 ? '#f59e0b' : '#ef4444';
  const subject = `Consult Score — ${location.franchise_name} — ${dateShort} — ${scorecard.total_score}/100${scorecard.flagged_for_review ? ' ⚠️' : ''}`;

  const audioTextBlock = audioUrl
    ? `\n\n--- RECORDING ---\nListen / Download: ${audioUrl}\n(Link expires in 7 days)\n`
    : '';

  const audioHtmlBlock = audioUrl
    ? `<div style="margin:24px 0;padding:16px 20px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;text-align:center;">
        <div style="font-size:12px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Consultation Recording</div>
        <a href="${audioUrl}" style="display:inline-block;padding:10px 24px;background:#0284c7;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Listen / Download Recording</a>
        <div style="font-size:11px;color:#64748b;margin-top:8px;">Link expires in 7 days</div>
      </div>`
    : '';

  const transcriptText = recording.transcript
    ? `\n\n--- FULL TRANSCRIPT ---\n${recording.transcript}\n--- END TRANSCRIPT ---`
    : '';

  const transcriptHtml = recording.transcript
    ? `<div style="margin:32px 0 0;">
        <h2 style="font-size:15px;font-weight:800;color:#111;margin:0 0 8px;padding-top:24px;border-top:2px solid #e5e7eb;">Full Transcript</h2>
        <p style="font-size:12px;color:#6b7280;margin:0 0 12px;">Raw transcription of the consultation audio.</p>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:18px;font-size:13px;color:#374151;line-height:1.8;white-space:pre-wrap;">${recording.transcript}</div>
      </div>`
    : '';

  const coachingNote = scorecard.coaching_note || '';

  // Plain text version
  const text = [
    `Hi ${location.franchisee_name},`,
    `Here is your consultation scorecard for ${date}.`,
    scorecard.flagged_for_review ? '\n⚠️ This consultation has been flagged for review by Mike.\n' : '',
    `OVERALL SCORE: ${scorecard.total_score}/100`,
    `Sit-Down Presentation: ${scorecard.sitdown_score}/25`,
    `Objection Handling: ${scorecard.objection_score}/25`,
    `Language & Psychology: ${scorecard.language_score}/25`,
    `Close Execution: ${scorecard.close_score}/25`,
    `\nSUMMARY:\n${scorecard.ai_summary}`,
    `\nCOACHING:\n${coachingNote}`,
    audioTextBlock,
    '\nEvery word matters. The script is built on human psychology — when you follow it, you give yourself the best possible chance of a yes.\n\nAira Fitness',
    transcriptText
  ].join('\n');

  // HTML version
  const footerMessage = scorecard.total_score >= 85
    ? 'Outstanding work — keep setting the standard.'
    : scorecard.total_score >= 70
    ? 'Solid consult — keep working the process and the scores will follow.'
    : 'Every rep makes you better — keep going.';

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">

    <div style="background:#111;padding:22px 28px;">
      <div style="font-size:18px;font-weight:800;color:#fff;">AIRA FITNESS</div>
      <div style="font-size:12px;color:#9ca3af;margin-top:3px;">Consultation Scorecard — ${date}</div>
    </div>

    <div style="padding:28px;">
      <p style="margin:0 0 20px;color:#374151;">Hi ${location.franchisee_name},</p>

      ${scorecard.flagged_for_review
        ? '<div style="background:#fff3cd;border-left:4px solid #ffc107;padding:10px 14px;margin-bottom:18px;border-radius:4px;">⚠️ <strong>This consultation has been flagged for review by Mike.</strong></div>'
        : ''}

      <div style="text-align:center;padding:20px;background:#f9fafb;border-radius:8px;margin-bottom:20px;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Overall Score</div>
        <div style="font-size:52px;font-weight:900;color:${scoreColor};line-height:1.1;">${scorecard.total_score}</div>
        <div style="font-size:14px;color:#9ca3af;">/ 100</div>
      </div>

      <table style="width:100%;border-collapse:collapse;">
        ${scoreRowHtml('Sit-Down Presentation', scorecard.sitdown_score, 25)}
        ${scoreRowHtml('Objection Handling', scorecard.objection_score, 25)}
        ${scoreRowHtml('Language & Psychology', scorecard.language_score, 25)}
        ${scoreRowHtml('Close Execution', scorecard.close_score, 25)}
      </table>

      <div style="padding:14px;background:#f0fdf4;border-left:3px solid #22c55e;border-radius:4px;margin:20px 0;">
        <div style="font-size:11px;font-weight:700;color:#166534;text-transform:uppercase;margin-bottom:5px;">Summary</div>
        <div style="font-size:13px;color:#15803d;">${scorecard.ai_summary}</div>
      </div>

      ${audioHtmlBlock}

      <div style="margin:24px 0;">
        <h2 style="font-size:15px;font-weight:800;color:#111;margin:0 0 16px;">Coaching</h2>
        <div style="font-size:14px;color:#374151;line-height:1.8;white-space:pre-wrap;">${coachingNote}</div>
      </div>

      ${transcriptHtml}
    </div>

    <div style="background:#f9fafb;padding:16px 28px;border-top:1px solid #e5e7eb;text-align:center;font-size:11px;color:#9ca3af;">
      ${footerMessage} | Aira Fitness
    </div>

  </div>
</body></html>`;

  const franchiseeEmail = (location.franchisee_email || '').trim() || MIKE_EMAIL;
  const recipients = [...new Set([franchiseeEmail, MIKE_EMAIL])];

  console.log('[Email] Attempting send to:', recipients.join(', '), '| from:', process.env.EMAIL_FROM || 'onboarding@resend.dev');

  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
    to: recipients,
    subject,
    text,
    html
  });

  if (error) {
    console.error('[Email] Resend rejected send:', JSON.stringify(error));
    throw new Error('Resend error: ' + JSON.stringify(error));
  }

  console.log(`[Email] Delivered — id: ${data?.id} — to: ${recipients.join(', ')} — score: ${scorecard.total_score}`);
}

module.exports = { sendScorecardEmail };
