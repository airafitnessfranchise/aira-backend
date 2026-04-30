// server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { byCalendarId, byLocationId } = require("./locations");
const { initDb, ...db } = require("./db");
const { transcribeAudio, scoreTranscript } = require("./ai");
const { sendScorecardEmail } = require("./email");
const { uploadToR2, getPresignedUrl } = require("./storage");
const vpRoutes = require("./vp-routes");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(vpRoutes);
app.use(express.static("public"));

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + uuidv4() + ".webm");
  },
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

const tabletConnections = new Map();

wss.on("connection", (ws, req) => {
  console.log("[WS] New connection from " + req.socket.remoteAddress);
  let registeredLocationId = null;
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "register") {
        const loc = byLocationId[(msg.location_id || "").toLowerCase()];
        if (!loc) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Unknown location: " + msg.location_id,
            }),
          );
          return;
        }
        registeredLocationId = (msg.location_id || "").toLowerCase();
        tabletConnections.set((msg.location_id || "").toLowerCase(), ws);
        ws.send(
          JSON.stringify({
            type: "registered",
            status: "ok",
            location: loc.franchise_name,
            message: "Registered as " + loc.franchise_name,
          }),
        );
        console.log("[WS] Tablet registered: " + msg.location_id);
      }
      if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    } catch (e) {
      console.error("[WS] Parse error:", e.message);
    }
  });
  ws.on("close", () => {
    if (registeredLocationId) {
      tabletConnections.delete(registeredLocationId);
      console.log("[WS] Tablet disconnected: " + registeredLocationId);
    }
  });
  ws.on("error", (err) => console.error("[WS] Error:", err.message));
  ws.send(
    JSON.stringify({ type: "connected", message: "Connected to Aira backend" }),
  );
});

function triggerTablet(location_id, appointment_id, contact_name) {
  const ws = tabletConnections.get(location_id);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("[WS] No active tablet for: " + location_id);
    return false;
  }
  ws.send(
    JSON.stringify({
      action: "start",
      appt_id: appointment_id,
      location: location_id,
      contact_name: contact_name || "Walk-in",
    }),
  );
  console.log("[WS] Triggered tablet at " + location_id);
  return true;
}

app.post("/webhook/ghl", async (req, res) => {
  // GHL auto-trigger DISABLED — tablets are manual-only.
  // We still accept the webhook so GHL doesn't error, and we log the payload
  // for debugging. No DB row, no tablet trigger, no ghost recordings.
  console.log(
    "[GHL] Webhook received (auto-trigger disabled):",
    JSON.stringify(req.body, null, 2),
  );
  res.json({
    success: true,
    message: "Webhook received (auto-trigger disabled — manual recording only)",
  });
});

app.post("/upload/recording", upload.single("audio_file"), async (req, res) => {
  console.log("[Upload] Audio file received");
  const appointment_id = req.body.appointment_id;
  const location_id = (req.body.location_id || "").toLowerCase();
  const duration_seconds = req.body.duration_seconds;
  const contact_name = req.body.contact_name;
  const file = req.file;
  if (!file)
    return res.status(400).json({ success: false, message: "No audio file" });
  console.log(
    "[Upload] Appt: " +
      appointment_id +
      ", Duration: " +
      duration_seconds +
      "s",
  );
  let recording = await db.findRecordingByApptId(appointment_id);
  if (recording) {
    await db.updateRecording(recording.recording_id, {
      audio_file_url: file.path,
      duration_seconds: parseInt(duration_seconds) || 0,
      processing_status: "uploaded",
      contact_name: contact_name || recording.contact_name || "Walk-in",
    });
  } else {
    recording = await db.createRecording({
      appointment_id: appointment_id || "manual-" + Date.now(),
      location_id: location_id || "unknown",
      duration_seconds: parseInt(duration_seconds) || 0,
      audio_file_url: file.path,
      contact_name: contact_name || "Walk-in",
    });
  }
  res.json({
    success: true,
    recording_id: recording.recording_id,
    message: "Audio received",
  });
  processRecording(
    recording.recording_id,
    file.path,
    location_id,
    appointment_id,
  );
});

async function processRecording(
  recording_id,
  audioFilePath,
  location_id,
  appointment_id,
  testOnly,
) {
  const location = byLocationId[location_id] || {
    location_id: location_id || "unknown",
    franchise_name: "Walk-in / Unknown Location",
    franchisee_name: "Franchisee",
    franchisee_email: process.env.MIKE_EMAIL || "mikebell@airafitness.com",
  };
  try {
    const existing = await db.getRecording(recording_id);
    const skipTranscribe =
      existing &&
      existing.processing_status === "transcribed" &&
      existing.transcript &&
      existing.transcript.length > 0;
    let r2Key = existing ? existing.r2_key : null;
    let transcript;
    if (skipTranscribe) {
      console.log("[Pipeline] Reusing existing transcript for " + recording_id);
      transcript = existing.transcript;
    } else {
      console.log("[Pipeline] Uploading to R2: " + recording_id);
      r2Key = await uploadToR2(audioFilePath, recording_id);
      if (r2Key) {
        await db.updateRecording(recording_id, { r2_key: r2Key });
        console.log("[Pipeline] R2 key stored: " + r2Key);
      }
      console.log("[Pipeline] Transcribing " + recording_id);
      await db.updateRecording(recording_id, {
        processing_status: "transcribing",
      });
      transcript = await transcribeAudio(audioFilePath);
      await db.updateRecording(recording_id, {
        transcript: transcript,
        processing_status: "transcribed",
      });
    }
    console.log("[Pipeline] Scoring " + recording_id);
    await db.updateRecording(recording_id, { processing_status: "scoring" });
    const scorecard = await scoreTranscript(transcript);
    const savedScorecard = await db.createScorecard({
      recording_id: recording_id,
      scorecard: scorecard,
    });
    await db.updateRecording(recording_id, { processing_status: "scored" });
    const audioUrl = r2Key ? await getPresignedUrl(r2Key) : null;
    if (audioUrl)
      console.log("[Pipeline] Presigned URL generated for " + recording_id);
    const recording = await db.getRecording(recording_id);
    if (location && recording) {
      await sendScorecardEmail(
        location,
        recording,
        savedScorecard,
        audioUrl,
        testOnly,
      );
      const threshold = parseInt(process.env.FLAG_SCORE_THRESHOLD) || 70;
      if (savedScorecard.total_score < threshold)
        console.log(
          "[Pipeline] Score " +
            savedScorecard.total_score +
            " below threshold — flagged",
        );
    }
    console.log(
      "[Pipeline] Complete: " +
        recording_id +
        " score=" +
        savedScorecard.total_score,
    );
  } catch (err) {
    console.error("[Pipeline] Error:", err.message);
    await db.updateRecording(recording_id, { processing_status: "failed" });
  }
}

async function runReaper() {
  try {
    const stuck = await db.findAndReapStuckRecordings();
    if (!stuck.length) {
      console.log("[Reaper] No stuck recordings");
      return;
    }
    for (const r of stuck) {
      const ageMins = Math.round(Number(r.age_minutes));
      console.log(
        "[Reaper] Re-enqueued " +
          r.recording_id +
          " (was " +
          r.processing_status +
          ", age " +
          ageMins +
          "m)",
      );
      processRecording(
        r.recording_id,
        r.audio_file_url,
        r.location_id,
        r.appointment_id,
      );
    }
  } catch (err) {
    console.error("[Reaper] Error:", err.message);
  }
}

app.post("/admin/rescore/:id", async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey)
    return res
      .status(503)
      .json({ ok: false, error: "ADMIN_KEY not configured" });
  if (req.headers["x-admin-key"] !== adminKey)
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  const id = req.params.id;
  const recording = await db.getRecording(id);
  if (!recording)
    return res.status(404).json({ ok: false, error: "Recording not found" });
  const nextStatus =
    recording.transcript && recording.transcript.length > 0
      ? "transcribed"
      : "uploaded";
  await db.updateRecording(id, { processing_status: nextStatus });
  const testOnly =
    req.query.test_only === "1" || req.query.test_only === "true";
  const started_at = new Date().toISOString();
  console.log(
    "[Rescore] Manual re-enqueue " +
      id +
      " as " +
      nextStatus +
      (testOnly ? " (TEST MODE)" : ""),
  );
  processRecording(
    id,
    recording.audio_file_url,
    recording.location_id,
    recording.appointment_id,
    testOnly,
  );
  res.json({ ok: true, id, started_at, test_only: !!testOnly });
});

app.get("/admin", async (req, res) => {
  try {
    const recordings = await db.getAllRecordings();
    const scorecards = await db.getAllScorecards();
    const scorecardMap = {};
    scorecards.forEach((s) => { scorecardMap[s.recording_id] = s; });
    const connectedTablets = Array.from(tabletConnections.keys());

    const fmtDate = (d) => new Date(d).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const fmtDuration = (sec) => Math.round(sec / 60) + "m " + (sec % 60) + "s";

    const scorePill = (sc) => {
      if (!sc) return '<span style="color:#9CA3AF;font-size:12px;">—</span>';
      const score = sc.total_score;
      const color = score >= 70 ? "#00AEEF" : score >= 50 ? "#0284C7" : "#DC2626";
      return `<a href="/scorecard/${sc.recording_id}" target="_blank" style="display:inline-block;padding:4px 10px;background:#fff;border:1.5px solid ${color};color:${color};border-radius:9999px;font-size:12px;font-weight:800;text-decoration:none;letter-spacing:.02em;">${score}<span style="color:#9CA3AF;font-weight:600;"> / 100</span></a>`;
    };

    const statusPill = (status) => {
      const s = status || "pending";
      let bg = "#F3F4F6", color = "#6B7280", border = "#E5E7EB";
      if (s === "transcribing" || s === "scoring" || s === "transcribed") { bg = "#E0F4FB"; color = "#0284C7"; border = "#BAE6FD"; }
      else if (s === "scored") { bg = "#0A0A0A"; color = "#fff"; border = "#0A0A0A"; }
      else if (s === "failed") { bg = "#FEE2E2"; color = "#DC2626"; border = "#FECACA"; }
      return `<span style="display:inline-block;padding:3px 10px;background:${bg};color:${color};border:1px solid ${border};border-radius:9999px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">${s}</span>`;
    };

    const rows = recordings.map((r) => {
      const sc = scorecardMap[r.recording_id];
      const loc = byLocationId[r.location_id] || {};
      const name = r.contact_name || r.appointment_id;
      return `<tr>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#6B7280;white-space:nowrap;">${fmtDate(r.recorded_at)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#111827;font-weight:600;">${loc.franchise_name || r.location_id}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#374151;">${name}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#6B7280;white-space:nowrap;">${fmtDuration(r.duration_seconds)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;">${statusPill(r.processing_status)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;">${scorePill(sc)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;">${r.audio_file_url ? `<a href="/playback/${r.recording_id}" style="color:#0284C7;text-decoration:none;font-weight:600;">▶ Play</a>` : '<span style="color:#D1D5DB;">—</span>'}</td>
      </tr>`;
    }).join("");

    const html = `<!DOCTYPE html><html><head><title>Aira Admin</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:#EEF1F4;color:#111827;-webkit-font-smoothing:antialiased;}
a{color:#0284C7;}
.wrap{max-width:1200px;margin:0 auto;padding:0 24px 48px;}
.brand{background:#0A0A0A;padding:22px 28px;text-align:center;}
.brand-mark{font-size:22px;font-weight:900;letter-spacing:.18em;line-height:1;}
.brand-mark .b{color:#00AEEF;} .brand-mark .w{color:#fff;}
.subhead{background:#fff;border-bottom:3px solid #00AEEF;padding:24px 28px;}
.subhead-inner{max-width:1200px;margin:0 auto;}
.eyebrow{font-size:10px;font-weight:800;color:#00AEEF;letter-spacing:.18em;text-transform:uppercase;margin-bottom:6px;}
.title{font-size:24px;font-weight:900;color:#0A0A0A;letter-spacing:-.01em;}
.subtitle{font-size:13px;color:#6B7280;margin-top:2px;}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:24px 0 20px;}
.card{background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:18px 20px;}
.card-num{font-size:30px;font-weight:900;color:#00AEEF;line-height:1.1;letter-spacing:-.02em;}
.card-label{font-size:10px;font-weight:800;color:#6B7280;text-transform:uppercase;letter-spacing:.12em;margin-top:6px;}
.tablets-card .card-num{color:${connectedTablets.length > 0 ? "#00AEEF" : "#9CA3AF"};}
.tablets-list{font-size:11px;color:#6B7280;margin-top:6px;}
.table-wrap{background:#fff;border:1px solid #E5E7EB;border-radius:10px;overflow:hidden;}
table{width:100%;border-collapse:collapse;}
thead th{background:#F9FAFB;padding:12px 16px;text-align:left;font-size:10px;color:#6B7280;font-weight:800;text-transform:uppercase;letter-spacing:.12em;border-bottom:1px solid #E5E7EB;}
tbody tr:last-child td{border-bottom:none;}
tbody tr:hover{background:#F9FAFB;}
.empty{text-align:center;color:#9CA3AF;padding:40px;font-size:13px;}
.refresh{font-size:11px;color:#9CA3AF;margin-top:14px;text-align:right;}
</style></head><body>
<div class="brand"><div class="brand-mark"><span class="b">AIRA</span>&nbsp;<span class="w">FITNESS</span></div></div>
<div class="subhead"><div class="subhead-inner">
  <div class="eyebrow">Consult Recorder</div>
  <div class="title">Admin Dashboard</div>
  <div class="subtitle">Live view of all consultation recordings and scoring</div>
</div></div>
<div class="wrap">
  <div class="cards">
    <div class="card"><div class="card-num">${recordings.length}</div><div class="card-label">Recordings</div></div>
    <div class="card"><div class="card-num">${scorecards.length}</div><div class="card-label">Scorecards</div></div>
    <div class="card tablets-card"><div class="card-num">${connectedTablets.length}</div><div class="card-label">Tablets Online</div>${connectedTablets.length ? `<div class="tablets-list">${connectedTablets.join(", ")}</div>` : ""}</div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Date</th><th>Location</th><th>Prospect</th><th>Duration</th><th>Status</th><th>Score</th><th>Audio</th>
      </tr></thead>
      <tbody>
        ${rows || '<tr><td colspan="7" class="empty">No recordings yet</td></tr>'}
      </tbody>
    </table>
  </div>
  <div class="refresh">Auto-refreshes every 30 seconds</div>
</div>
<script>setTimeout(()=>location.reload(),30000);</script>
</body></html>`;
    res.send(html);
  } catch (err) {
    console.error("[Admin] Error:", err.message);
    res.status(500).send("Error loading admin: " + err.message);
  }
});

app.get("/scorecard/:id", async (req, res) => {
  try {
    const r = await db.getRecording(req.params.id);
    if (!r) return res.status(404).send("Recording not found");
    const s = await db.getScorecardByRecording(req.params.id);
    if (!s) return res.status(404).send("Scorecard not yet available — check back after processing completes.");
    const { byLocationId } = require("./locations");
    const loc = byLocationId[r.location_id] || {};
    const name = r.contact_name || r.appointment_id;
    const date = new Date(r.recorded_at).toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const scoreColor = s.total_score >= 70 ? "#00AEEF" : s.total_score >= 50 ? "#0284C7" : "#DC2626";
    const sections = [
      ["Sit-Down Presentation", s.sitdown_score, s.sitdown_score_explainer],
      ["Objection Handling", s.objection_score, s.objection_score_explainer],
      ["Language & Psychology", s.language_score, s.language_score_explainer],
      ["Close Execution", s.close_score, s.close_score_explainer],
    ];
    const sectionRow = ([label, score, explainer]) => {
      const pct = score != null ? (score / 25) * 100 : 0;
      const c = pct >= 70 ? "#00AEEF" : pct >= 50 ? "#0284C7" : "#DC2626";
      return `<div style="margin-top:14px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <div style="font-size:14px;font-weight:700;color:#111827;">${label}</div>
          <div style="font-size:14px;font-weight:800;color:${c};">${score != null ? score : "—"}<span style="color:#6B7280;font-weight:600;"> / 25</span></div>
        </div>
        <div style="background:#F3F4F6;border-radius:9999px;height:6px;margin-top:8px;overflow:hidden;">
          <div style="background:${c};width:${pct}%;height:6px;"></div>
        </div>
        ${explainer ? `<div style="font-size:13px;color:#6B7280;line-height:1.55;margin:6px 0 14px;">${explainer}</div>` : '<div style="margin-bottom:14px;"></div>'}
      </div>`;
    };
    const closedBadge = s.did_close === true
      ? `<div style="display:inline-block;padding:6px 14px;background:#0A0A0A;color:#fff;border-radius:9999px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-top:10px;"><span style="color:#00AEEF;">✓</span> Sale Closed</div>`
      : "";

    res.send(`<!DOCTYPE html><html><head><title>Scorecard — ${name}</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:#EEF1F4;color:#111827;-webkit-font-smoothing:antialiased;}
a{color:#0284C7;}
.brand{background:#0A0A0A;padding:22px 28px;text-align:center;}
.brand-mark{font-size:22px;font-weight:900;letter-spacing:.18em;line-height:1;}
.brand-mark .b{color:#00AEEF;} .brand-mark .w{color:#fff;}
.subhead{background:#fff;border-bottom:3px solid #00AEEF;padding:22px 28px 14px;}
.subhead-inner{max-width:840px;margin:0 auto;}
.eyebrow{font-size:10px;font-weight:800;color:#00AEEF;letter-spacing:.18em;text-transform:uppercase;margin-bottom:6px;}
.title{font-size:24px;font-weight:900;color:#0A0A0A;letter-spacing:-.01em;line-height:1.15;}
.subtitle{font-size:13px;color:#6B7280;margin-top:4px;}
.wrap{max-width:840px;margin:0 auto;padding:24px;}
.back{display:inline-block;color:#6B7280;font-size:12px;text-decoration:none;margin-bottom:16px;font-weight:600;}
.back:hover{color:#0A0A0A;}
.flag{display:inline-block;background:#fff;border:1px solid #DC2626;border-left:4px solid #DC2626;color:#111827;padding:8px 14px;border-radius:4px;font-size:12px;font-weight:600;margin-bottom:16px;}
.card{background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:24px;margin-bottom:16px;}
.score-card{text-align:center;padding:28px;background:#F9FAFB;}
.score-label{font-size:10px;color:#6B7280;text-transform:uppercase;letter-spacing:.14em;font-weight:800;}
.score-big{font-size:62px;font-weight:900;color:${scoreColor};line-height:1.05;margin-top:6px;letter-spacing:-.02em;}
.score-of{font-size:22px;color:#6B7280;font-weight:600;letter-spacing:0;}
.summary{padding:18px 20px;background:#F9FAFB;border-left:3px solid #00AEEF;border-radius:4px;margin-bottom:16px;}
.summary-label{font-size:10px;font-weight:800;color:#0284C7;text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px;}
.summary-body{font-size:14px;color:#111827;line-height:1.6;}
.section-block{padding:24px;}
.section-title{font-size:10px;font-weight:800;color:#6B7280;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;}
.coaching{background:#fff;border:1px solid #E5E7EB;border-left:4px solid #00AEEF;border-radius:6px;padding:24px;margin-bottom:16px;}
.coaching-header{font-size:11px;font-weight:800;color:#0A0A0A;text-transform:uppercase;letter-spacing:.14em;margin-bottom:14px;}
.coaching-body{font-size:14.5px;color:#111827;line-height:1.7;}
.coaching-body p{margin-top:12px;}
.coaching-body p:first-child{margin-top:0;}
.transcript{background:#F9FAFB;border:1px solid #E5E7EB;border-radius:6px;padding:18px;font-size:13px;color:#374151;line-height:1.6;white-space:pre-wrap;max-height:500px;overflow-y:auto;}
</style></head><body>
<div class="brand"><div class="brand-mark"><span class="b">AIRA</span>&nbsp;<span class="w">FITNESS</span></div></div>
<div class="subhead"><div class="subhead-inner">
  <div class="eyebrow">Consultation Scorecard</div>
  <div class="title">${loc.franchise_name || r.location_id}</div>
  <div class="subtitle">${date} &nbsp;·&nbsp; ${name} &nbsp;·&nbsp; ${Math.round(r.duration_seconds / 60)}m ${r.duration_seconds % 60}s</div>
</div></div>
<div class="wrap">
  <a href="/admin" class="back">← Back to Admin</a>
  ${s.flagged_for_review ? '<div class="flag">⚠ Flagged for Review</div>' : ""}
  <div class="card score-card">
    <div class="score-label">Overall Score</div>
    <div class="score-big">${s.total_score}<span class="score-of"> / 100</span></div>
    ${closedBadge}
  </div>
  <div class="summary">
    <div class="summary-label">Summary</div>
    <div class="summary-body">${s.ai_summary || ""}</div>
  </div>
  <div class="card section-block">
    ${sections.map(sectionRow).join("")}
  </div>
  ${s.overall_coaching || s.coaching_note ? `<div class="coaching">
    <div class="coaching-header">Coaching Notes</div>
    <div class="coaching-body"><p>${(s.overall_coaching || s.coaching_note).replace(/\n\n+/g, '</p><p>').replace(/\n/g, " ")}</p></div>
  </div>` : ""}
  ${r.transcript ? `<div class="card">
    <div class="section-title">Full Transcript</div>
    <div class="transcript">${r.transcript}</div>
  </div>` : ""}
</div>
</body></html>`);
  } catch (err) {
    console.error("[Scorecard] Error:", err.message);
    res.status(500).send("Error loading scorecard: " + err.message);
  }
});

app.get("/playback/:recording_id", async (req, res) => {
  const rec = await db.getRecording(req.params.recording_id);
  if (!rec || !rec.audio_file_url) return res.status(404).send("Not found");
  const name = rec.contact_name || rec.appointment_id;
  const loc = byLocationId[rec.location_id] || {};
  const dt = new Date(rec.recorded_at).toLocaleString("en-US", { timeZone: "America/Chicago" });
  res.send(`<!DOCTYPE html><html><head><title>Playback — ${name}</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:#EEF1F4;color:#111827;-webkit-font-smoothing:antialiased;}
.brand{background:#0A0A0A;padding:22px 28px;text-align:center;}
.brand-mark{font-size:22px;font-weight:900;letter-spacing:.18em;line-height:1;}
.brand-mark .b{color:#00AEEF;} .brand-mark .w{color:#fff;}
.subhead{background:#fff;border-bottom:3px solid #00AEEF;padding:22px 28px 14px;}
.subhead-inner{max-width:760px;margin:0 auto;}
.eyebrow{font-size:10px;font-weight:800;color:#00AEEF;letter-spacing:.18em;text-transform:uppercase;margin-bottom:6px;}
.title{font-size:22px;font-weight:900;color:#0A0A0A;letter-spacing:-.01em;line-height:1.2;}
.subtitle{font-size:13px;color:#6B7280;margin-top:4px;}
.wrap{max-width:760px;margin:0 auto;padding:24px;}
.back{display:inline-block;color:#6B7280;font-size:12px;text-decoration:none;margin-bottom:16px;font-weight:600;}
.back:hover{color:#0A0A0A;}
.card{background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:24px;margin-bottom:16px;}
audio{width:100%;}
.section-title{font-size:10px;font-weight:800;color:#6B7280;text-transform:uppercase;letter-spacing:.12em;margin-bottom:10px;}
.transcript{font-size:13px;color:#374151;line-height:1.7;white-space:pre-wrap;}
</style></head><body>
<div class="brand"><div class="brand-mark"><span class="b">AIRA</span>&nbsp;<span class="w">FITNESS</span></div></div>
<div class="subhead"><div class="subhead-inner">
  <div class="eyebrow">Recording Playback</div>
  <div class="title">${name}</div>
  <div class="subtitle">${loc.franchise_name || rec.location_id} &nbsp;·&nbsp; ${dt}</div>
</div></div>
<div class="wrap">
  <a href="/admin" class="back">← Back to Admin</a>
  <div class="card">
    <div class="section-title">Audio</div>
    <audio controls><source src="/audio/${path.basename(rec.audio_file_url)}"></audio>
  </div>
  ${rec.transcript ? `<div class="card">
    <div class="section-title">Transcript</div>
    <div class="transcript">${rec.transcript}</div>
  </div>` : `<div class="card"><div style="color:#9CA3AF;font-size:13px;">No transcript yet</div></div>`}
</div>
</body></html>`);
});

app.use("/audio", express.static(UPLOAD_DIR));

app.get("/status", async (req, res) => {
  const recordings = await db.getAllRecordings();
  const scorecards = await db.getAllScorecards();
  res.json({
    status: "ok",
    tablets_connected: tabletConnections.size,
    tablets: Array.from(tabletConnections.keys()),
    recordings: recordings.length,
    scorecards: scorecards.length,
    uptime_seconds: Math.round(process.uptime()),
  });
});

app.post("/test/trigger", async (req, res) => {
  const location_id = req.body.location_id;
  const apptId = req.body.appointment_id || "TEST-" + Date.now();
  const triggered = triggerTablet(location_id, apptId);
  const recording = await db.createRecording({
    appointment_id: apptId,
    location_id: location_id,
  });
  res.json({
    triggered: triggered,
    appointment_id: apptId,
    recording_id: recording.recording_id,
  });
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(async () => {
    await runReaper();
    server.listen(PORT, () => {
      console.log("Aira backend running on port " + PORT);
      console.log(
        "[Locations] " +
          Object.keys(byLocationId).length +
          " location(s) loaded",
      );
    });
  })
  .catch((err) => {
    console.error("[DB] Failed to init:", err.message);
    process.exit(1);
  });

// v1774065872281
