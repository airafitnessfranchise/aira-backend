// email.js
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);
const MIKE_EMAIL = process.env.MIKE_EMAIL || "mikebell@airafitness.com";
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  "https://aira-backend-production-2a71.up.railway.app";
const BRAND_BLUE = "#00AEEF"; // logo accent
const BRAND_BLUE_DARK = "#0284C7"; // for hover/border accents
const BRAND_BLACK = "#0A0A0A"; // header / footer
const NEUTRAL_900 = "#111827"; // primary text
const NEUTRAL_700 = "#374151"; // body text
const NEUTRAL_500 = "#6B7280"; // muted text
const NEUTRAL_300 = "#D1D5DB"; // borders
const NEUTRAL_100 = "#F3F4F6"; // page bg
const NEUTRAL_50 = "#F9FAFB"; // card bg
const ALERT_RED = "#DC2626"; // only used for sub-50 scores

// Renders one score row: label, score/max, progress bar, and the 1-2 sentence explainer.
function scoreRowHtml(label, score, max, explainer) {
  const pct = Math.round((score / max) * 100);
  // Blue-forward palette: high = brand blue, mid = darker brand blue, low = red.
  // No green, no orange — colors stay coherent with the logo.
  const color =
    pct >= 70 ? BRAND_BLUE : pct >= 50 ? BRAND_BLUE_DARK : ALERT_RED;
  const explainerHtml = explainer
    ? `<div style="font-size:12px;color:${NEUTRAL_500};line-height:1.5;margin:4px 0 14px;">${explainer}</div>`
    : '<div style="margin-bottom:14px;"></div>';
  return `
    <div style="margin-top:14px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tr>
        <td style="text-align:left;vertical-align:baseline;font-size:13px;color:${NEUTRAL_900};font-weight:700;letter-spacing:.01em;">${label}</td>
        <td style="text-align:right;vertical-align:baseline;font-size:13px;font-weight:800;color:${color};">${score}<span style="color:${NEUTRAL_500};font-weight:600;"> / ${max}</span></td>
      </tr></table>
      <div style="background:${NEUTRAL_100};border-radius:9999px;height:6px;margin-top:8px;overflow:hidden;">
        <div style="background:${color};width:${pct}%;height:6px;border-radius:9999px;"></div>
      </div>
      ${explainerHtml}
    </div>`;
}

function scoreRowText(label, score, max, explainer) {
  let out = `${label}: ${score}/${max}`;
  if (explainer) out += `\n  ${explainer}`;
  return out;
}

// Score-aware coaching header. Returns null when there's no coaching body to render.
function coachingHeaderFor(scorecard) {
  const body = (
    scorecard.overall_coaching ||
    scorecard.coaching_note ||
    ""
  ).trim();
  if (!body) return null;
  const didClose = scorecard.did_close === true;
  const score = scorecard.total_score || 0;
  if (score >= 85) return "PERFECT EXECUTION";
  if (score >= 70 && didClose) return "YOU CLOSED IT — BUT READ THIS";
  if (score >= 70) return "STRONG WORK — ONE THING TO TIGHTEN";
  return "HERE'S WHAT TO FIX FIRST";
}

// Greeting fallback when franchisee_name is a placeholder ("employee", "test", "placeholder").
function greetingNameFor(location) {
  const name = (location.franchisee_name || "").trim();
  if (!name || /\b(employee|test|placeholder)\b/i.test(name)) {
    const franchise = (location.franchise_name || "Aira Fitness").trim();
    return franchise + " Team";
  }
  return name;
}

async function sendScorecardEmail(
  location,
  recording,
  scorecard,
  audioUrl,
  testOnly,
) {
  const date = new Date(recording.recorded_at).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const dateShort = new Date(recording.recorded_at).toLocaleDateString(
    "en-US",
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    },
  );

  const scoreColor =
    scorecard.total_score >= 70
      ? BRAND_BLUE
      : scorecard.total_score >= 50
        ? BRAND_BLUE_DARK
        : ALERT_RED;
  const subject = `${location.franchise_name || "Aira Fitness"} — Consult Score ${scorecard.total_score}/100 — ${dateShort}${scorecard.flagged_for_review ? " ⚠️" : ""}`;

  const didClose = scorecard.did_close === true;
  const coachingBody = (
    scorecard.overall_coaching ||
    scorecard.coaching_note ||
    ""
  ).trim();
  const coachingHeader = coachingHeaderFor(scorecard);

  const audioTextBlock = audioUrl
    ? `\n\n--- RECORDING ---\nListen / Download: ${audioUrl}\n(Link expires in 7 days)\n`
    : "";

  const audioHtmlBlock = audioUrl
    ? `<div style="margin:24px 0;padding:18px 20px;background:${NEUTRAL_50};border:1px solid ${NEUTRAL_300};border-radius:6px;text-align:center;">
        <div style="font-size:10px;font-weight:800;color:${NEUTRAL_500};text-transform:uppercase;letter-spacing:.12em;margin-bottom:10px;">Consultation Recording</div>
        <a href="${audioUrl}" style="display:inline-block;padding:11px 26px;background:${BRAND_BLACK};color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:700;letter-spacing:.02em;">▶  Listen / Download</a>
        <div style="font-size:11px;color:${NEUTRAL_500};margin-top:10px;">Link expires in 7 days</div>
      </div>`
    : "";

  const transcriptText = recording.transcript
    ? `\n\n--- FULL TRANSCRIPT ---\n${recording.transcript}\n--- END TRANSCRIPT ---`
    : "";

  const transcriptHtml = recording.transcript
    ? `<div style="margin:28px 0 0;padding-top:22px;border-top:1px solid ${NEUTRAL_300};">
        <div style="font-size:10px;font-weight:800;color:${NEUTRAL_500};text-transform:uppercase;letter-spacing:.12em;margin-bottom:10px;">Full Transcript</div>
        <div style="background:${NEUTRAL_50};border:1px solid ${NEUTRAL_300};border-radius:6px;padding:16px 18px;font-size:13px;color:${NEUTRAL_700};line-height:1.6;white-space:pre-wrap;">${recording.transcript}</div>
      </div>`
    : "";

  // The single coaching block (orange callout). Only renders if there's real coaching.
  const coachingHtml =
    coachingHeader && coachingBody
      ? `<div style="margin:24px 0;padding:22px 24px;background:#fff;border:1px solid ${NEUTRAL_300};border-left:4px solid ${BRAND_BLUE};border-radius:6px;">
        <div style="font-size:10px;font-weight:800;color:${BRAND_BLACK};text-transform:uppercase;letter-spacing:.14em;margin-bottom:14px;">${coachingHeader}</div>
        <div style="font-size:14.5px;color:${NEUTRAL_900};line-height:1.7;"><p style="margin:0;">${coachingBody.replace(/\n\n+/g, '</p><p style="margin:12px 0 0;">').replace(/\n/g, " ")}</p></div>
      </div>`
      : "";

  const coachingTextBlock =
    coachingHeader && coachingBody
      ? `\n\n⚠ ${coachingHeader}\n${coachingBody}\n`
      : "";

  // Plain text version
  const text = [
    `${(location.franchise_name || "Aira Fitness").toUpperCase()}`,
    `Consultation Scorecard — ${date}`,
    "",
    `Hi ${greetingNameFor(location)},`,
    scorecard.flagged_for_review
      ? "\n⚠️ This consultation has been flagged for review by Mike.\n"
      : "",
    didClose ? "✓ SALE CLOSED" : "",
    `\nOVERALL SCORE: ${scorecard.total_score}/100\n`,
    scoreRowText(
      "Sit-Down Presentation",
      scorecard.sitdown_score,
      25,
      scorecard.sitdown_score_explainer,
    ),
    scoreRowText(
      "Objection Handling",
      scorecard.objection_score,
      25,
      scorecard.objection_score_explainer,
    ),
    scoreRowText(
      "Language & Psychology",
      scorecard.language_score,
      25,
      scorecard.language_score_explainer,
    ),
    scoreRowText(
      "Close Execution",
      scorecard.close_score,
      25,
      scorecard.close_score_explainer,
    ),
    `\nSUMMARY:\n${scorecard.ai_summary}`,
    coachingTextBlock,
    audioTextBlock,
    "\nEvery word matters. The script is built on human psychology — when you follow it, you give yourself the best possible chance of a yes.\n\nAira Fitness",
    transcriptText,
  ]
    .filter(Boolean)
    .join("\n");

  const footerMessage =
    scorecard.total_score >= 85
      ? "Outstanding work — keep setting the standard."
      : scorecard.total_score >= 70
        ? "Solid consult — keep working the process and the scores will follow."
        : "Every rep makes you better — keep going.";

  const closedBadge = didClose
    ? `<div style="display:inline-block;padding:6px 14px;background:${BRAND_BLACK};color:#fff;border-radius:9999px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-top:10px;"><span style="color:${BRAND_BLUE};">✓</span> Sale Closed</div>`
    : "";

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#EEF1F4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:640px;margin:20px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">

    <div style="background:${BRAND_BLACK};padding:28px 28px;text-align:center;">
      <div style="font-size:26px;font-weight:900;letter-spacing:.18em;line-height:1;">
        <span style="color:${BRAND_BLUE};">AIRA</span><span style="color:#fff;">&nbsp;FITNESS</span>
      </div>
    </div>

    <div style="background:#fff;padding:24px 28px 14px;border-bottom:3px solid ${BRAND_BLUE};">
      <div style="font-size:10px;font-weight:800;color:${BRAND_BLUE};letter-spacing:.18em;text-transform:uppercase;margin-bottom:6px;">Consultation Scorecard</div>
      <div style="font-size:24px;font-weight:900;color:${BRAND_BLACK};margin:0 0 4px;line-height:1.15;letter-spacing:-.01em;">${location.franchise_name || "Aira Fitness"}</div>
      <div style="font-size:12px;color:${NEUTRAL_500};font-weight:500;">${date}</div>
    </div>

    <div style="padding:24px 28px;">
      <p style="margin:0 0 20px;color:${NEUTRAL_700};font-size:14px;">Hi ${greetingNameFor(location)},</p>

      ${
        scorecard.flagged_for_review
          ? `<div style="background:#fff;border:1px solid ${ALERT_RED};border-left:4px solid ${ALERT_RED};padding:11px 14px;margin-bottom:18px;border-radius:4px;font-size:13px;color:${NEUTRAL_900};">⚠️ <strong>This consultation has been flagged for review by Mike.</strong></div>`
          : ""
      }

      <div style="text-align:center;padding:22px 18px;background:${NEUTRAL_50};border-radius:8px;margin-bottom:24px;">
        <div style="font-size:10px;color:${NEUTRAL_500};text-transform:uppercase;letter-spacing:.14em;font-weight:800;">Overall Score</div>
        <div style="font-size:54px;font-weight:900;color:${scoreColor};line-height:1.05;margin-top:6px;letter-spacing:-.02em;">${scorecard.total_score}<span style="font-size:20px;color:${NEUTRAL_500};font-weight:600;letter-spacing:0;"> / 100</span></div>
        ${closedBadge}
      </div>

      <div style="margin:8px 0 20px;">
        ${scoreRowHtml("Sit-Down Presentation", scorecard.sitdown_score, 25, scorecard.sitdown_score_explainer)}
        ${scoreRowHtml("Objection Handling", scorecard.objection_score, 25, scorecard.objection_score_explainer)}
        ${scoreRowHtml("Language & Psychology", scorecard.language_score, 25, scorecard.language_score_explainer)}
        ${scoreRowHtml("Close Execution", scorecard.close_score, 25, scorecard.close_score_explainer)}
      </div>

      <div style="padding:16px 18px;background:${NEUTRAL_50};border-left:3px solid ${BRAND_BLUE};border-radius:4px;margin:20px 0 16px;">
        <div style="font-size:10px;font-weight:800;color:${BRAND_BLUE_DARK};text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px;">Summary</div>
        <div style="font-size:14px;color:${NEUTRAL_900};line-height:1.6;">${scorecard.ai_summary}</div>
      </div>

      ${coachingHtml}

      ${audioHtmlBlock}

      ${transcriptHtml}
    </div>

    <div style="background:${BRAND_BLACK};padding:14px 28px;text-align:center;font-size:11px;color:#9ca3af;">
      <div style="color:#fff;font-weight:600;margin-bottom:2px;">${footerMessage}</div>
      <div style="color:${BRAND_BLUE};font-weight:700;letter-spacing:.1em;font-size:10px;text-transform:uppercase;">Aira Fitness</div>
    </div>

  </div>
</body></html>`;

  // Recipients: franchisee + MIKE + optional vp + optional club, deduped.
  const franchiseeEmail = (location.franchisee_email || "").trim();
  const recipients = testOnly
    ? [MIKE_EMAIL]
    : [
        ...new Set(
          [franchiseeEmail, MIKE_EMAIL, location.vp_email, location.club_email]
            .map((e) => (e || "").trim())
            .filter(Boolean),
        ),
      ];
  if (testOnly) console.log("[Email] TEST MODE — sending to MIKE only");

  console.log(
    "[Email] Attempting send to:",
    recipients.join(", "),
    "| from:",
    process.env.EMAIL_FROM || "onboarding@resend.dev",
  );

  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM || "onboarding@resend.dev",
    to: recipients,
    subject,
    text,
    html,
  });

  if (error) {
    console.error("[Email] Resend rejected send:", JSON.stringify(error));
    throw new Error("Resend error: " + JSON.stringify(error));
  }

  console.log(
    `[Email] Delivered — id: ${data?.id} — to: ${recipients.join(", ")} — score: ${scorecard.total_score}`,
  );
}

// ─────────── PRACTICE SESSION EMAIL ───────────
// Same brand language as the consult scorecard email, plus the back-and-forth
// conversation. Sent to MIKE_EMAIL only by default — practice is internal training data.

function escapeHtmlMail(t) {
  return String(t || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendPracticeEmail({
  session_id,
  location,
  difficulty,
  persona_label,
  messages,
  scorecard,
}) {
  const sc = scorecard || {};
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const dateShort = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const totalColor =
    (sc.total_score || 0) >= 70
      ? BRAND_BLUE
      : (sc.total_score || 0) >= 50
        ? BRAND_BLUE_DARK
        : ALERT_RED;

  const subject = `Practice — ${location.franchise_name || "Aira Fitness"} — ${persona_label} Prospect — ${sc.total_score || 0}/100`;

  const closedBadge =
    sc.did_close === true
      ? `<div style="display:inline-block;padding:6px 14px;background:${BRAND_BLACK};color:#fff;border-radius:9999px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-top:10px;"><span style="color:${BRAND_BLUE};">✓</span> Sale Closed</div>`
      : `<div style="display:inline-block;padding:6px 14px;background:#fff;border:1px solid ${ALERT_RED};color:${ALERT_RED};border-radius:9999px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-top:10px;">No Sale</div>`;

  const sections = [
    ["Sit-Down Presentation", sc.sitdown_score, sc.sitdown_score_explainer],
    ["Objection Handling", sc.objection_score, sc.objection_score_explainer],
    ["Language & Psychology", sc.language_score, sc.language_score_explainer],
    ["Close Execution", sc.close_score, sc.close_score_explainer],
  ];
  const barsHtml = sections
    .map(([label, score, expl]) => scoreRowHtml(label, score || 0, 25, expl))
    .join("");

  const coachingHeader = coachingHeaderFor(sc);
  const coachingBody = (sc.overall_coaching || sc.coaching_note || "").trim();
  const coachingHtml =
    coachingHeader && coachingBody
      ? `<div style="margin:24px 0;padding:22px 24px;background:#fff;border:1px solid ${NEUTRAL_300};border-left:4px solid ${BRAND_BLUE};border-radius:6px;">
        <div style="font-size:10px;font-weight:800;color:${BRAND_BLACK};text-transform:uppercase;letter-spacing:.14em;margin-bottom:14px;">${coachingHeader}</div>
        <div style="font-size:14.5px;color:${NEUTRAL_900};line-height:1.7;"><p style="margin:0;">${coachingBody.replace(/\n\n+/g, '</p><p style="margin:12px 0 0;">').replace(/\n/g, " ")}</p></div>
      </div>`
      : "";

  const conversationHtml =
    messages && messages.length
      ? `<div style="margin:24px 0;">
        <div style="font-size:10px;font-weight:800;color:${NEUTRAL_500};text-transform:uppercase;letter-spacing:.12em;margin-bottom:10px;">The Conversation</div>
        ${messages
          .map((m) => {
            const isRep = m.role === "user";
            const lbl = isRep ? "YOU SAID" : "PROSPECT SAID";
            const lblColor = isRep ? BRAND_BLUE : NEUTRAL_500;
            const bg = isRep ? "#F0FBFF" : NEUTRAL_50;
            const border = isRep ? "#BAE6FD" : NEUTRAL_300;
            return `<div style="background:${bg};border:1px solid ${border};border-radius:6px;padding:12px 14px;margin-bottom:8px;">
            <div style="font-size:10px;font-weight:800;letter-spacing:.14em;color:${lblColor};margin-bottom:4px;">${lbl}</div>
            <div style="font-size:13.5px;color:${NEUTRAL_900};line-height:1.55;">${escapeHtmlMail(m.content)}</div>
          </div>`;
          })
          .join("")}
      </div>`
      : "";

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#EEF1F4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:640px;margin:20px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
    <div style="background:${BRAND_BLACK};padding:28px 28px;text-align:center;">
      <div style="font-size:26px;font-weight:900;letter-spacing:.18em;line-height:1;">
        <span style="color:${BRAND_BLUE};">AIRA</span><span style="color:#fff;">&nbsp;FITNESS</span>
      </div>
    </div>
    <div style="background:#fff;padding:24px 28px 14px;border-bottom:3px solid ${BRAND_BLUE};">
      <div style="font-size:10px;font-weight:800;color:${BRAND_BLUE};letter-spacing:.18em;text-transform:uppercase;margin-bottom:6px;">Practice Session</div>
      <div style="font-size:24px;font-weight:900;color:${BRAND_BLACK};margin:0 0 4px;line-height:1.15;letter-spacing:-.01em;">${location.franchise_name || "Aira Fitness"}</div>
      <div style="font-size:12px;color:${NEUTRAL_500};font-weight:500;">${date} &nbsp;·&nbsp; ${persona_label} Prospect (${difficulty})</div>
    </div>
    <div style="padding:24px 28px;">
      <div style="text-align:center;padding:22px 18px;background:${NEUTRAL_50};border-radius:8px;margin-bottom:24px;">
        <div style="font-size:10px;color:${NEUTRAL_500};text-transform:uppercase;letter-spacing:.14em;font-weight:800;">Overall Score</div>
        <div style="font-size:54px;font-weight:900;color:${totalColor};line-height:1.05;margin-top:6px;letter-spacing:-.02em;">${sc.total_score || 0}<span style="font-size:20px;color:${NEUTRAL_500};font-weight:600;letter-spacing:0;"> / 100</span></div>
        ${closedBadge}
      </div>
      ${barsHtml ? `<div style="margin:8px 0 20px;">${barsHtml}</div>` : ""}
      ${
        sc.ai_summary
          ? `<div style="padding:16px 18px;background:${NEUTRAL_50};border-left:3px solid ${BRAND_BLUE};border-radius:4px;margin:20px 0 16px;">
        <div style="font-size:10px;font-weight:800;color:${BRAND_BLUE_DARK};text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px;">Summary</div>
        <div style="font-size:14px;color:${NEUTRAL_900};line-height:1.6;">${sc.ai_summary}</div>
      </div>`
          : ""
      }
      ${coachingHtml}
      ${conversationHtml}
    </div>
    <div style="background:${BRAND_BLACK};padding:14px 28px;text-align:center;font-size:11px;color:#9ca3af;">
      <div style="color:#fff;font-weight:600;margin-bottom:2px;">Practice session — internal training data</div>
      <div style="color:${BRAND_BLUE};font-weight:700;letter-spacing:.1em;font-size:10px;text-transform:uppercase;">Aira Fitness</div>
    </div>
  </div>
</body></html>`;

  const text = [
    `${(location.franchise_name || "Aira Fitness").toUpperCase()} — PRACTICE SESSION`,
    `${persona_label} Prospect (${difficulty}) — ${date}`,
    "",
    `Overall Score: ${sc.total_score || 0}/100  ${sc.did_close ? "(Sale Closed)" : "(No Sale)"}`,
    "",
    sections
      .map(([l, sv, e]) => `${l}: ${sv || 0}/25${e ? "\n  " + e : ""}`)
      .join("\n"),
    "",
    sc.ai_summary ? `Summary:\n${sc.ai_summary}` : "",
    coachingBody ? `\n--- ${coachingHeader} ---\n${coachingBody}` : "",
    "",
    "--- Conversation ---",
    (messages || [])
      .map(
        (m) =>
          (m.role === "user" ? "YOU SAID: " : "PROSPECT SAID: ") + m.content,
      )
      .join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n");

  const recipients = [MIKE_EMAIL];
  console.log(
    `[Practice Email] Sending session ${session_id} to: ${recipients.join(", ")}`,
  );

  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM || "onboarding@resend.dev",
    to: recipients,
    subject,
    text,
    html,
  });

  if (error) {
    console.error("[Practice Email] Resend rejected:", JSON.stringify(error));
    throw new Error("Resend error: " + JSON.stringify(error));
  }
  console.log(
    `[Practice Email] Delivered — id: ${data?.id} — score: ${sc.total_score || 0}`,
  );
}

module.exports = { sendScorecardEmail, sendPracticeEmail };
