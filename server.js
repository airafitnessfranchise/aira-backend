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
    scorecards.forEach(function (s) {
      scorecardMap[s.recording_id] = s;
    });
    const connectedTablets = Array.from(tabletConnections.keys());
    const rows = recordings
      .map(function (r) {
        const sc = scorecardMap[r.recording_id];
        const loc = byLocationId[r.location_id] || {};
        const name = r.contact_name || r.appointment_id;
        return (
          "<tr><td>" +
          new Date(r.recorded_at).toLocaleString("en-US", {
            timeZone: "America/Chicago",
          }) +
          "</td><td>" +
          (loc.franchise_name || r.location_id) +
          "</td><td>" +
          name +
          "</td><td>" +
          Math.round(r.duration_seconds / 60) +
          "m " +
          (r.duration_seconds % 60) +
          's</td><td class="status-' +
          (r.processing_status || "pending") +
          '">' +
          (r.processing_status || "pending") +
          "</td><td>" +
          (scorecardMap[r.recording_id]
            ? scorecardMap[r.recording_id].total_score + "/100"
            : "—") +
          "</td><td>" +
          (r.audio_file_url
            ? '<a href="/playback/' +
              r.recording_id +
              '" style="color:#c8f060">▶ Play</a>'
            : "—") +
          "</td><td>" +
          (scorecardMap[r.recording_id]
            ? '<a href="/scorecard/' +
              r.recording_id +
              '" target="_blank" style="color:#c8f060;font-weight:bold;text-decoration:none;">' +
              scorecardMap[r.recording_id].total_score +
              "/100 →</a>"
            : '<span style="color:#666;font-size:11px;">Pending</span>') +
          "</td>"
        );
      })
      .join("");
    res.send(
      '<!DOCTYPE html><html><head><title>Aira Admin</title><meta charset="utf-8"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#0a0a0a;color:#f0f0f0;padding:32px}h1{color:#c8f060;font-size:24px;margin-bottom:4px}.sub{color:#666;font-size:13px;margin-bottom:32px}.cards{display:flex;gap:16px;margin-bottom:32px;flex-wrap:wrap}.card{background:#111;border:1px solid #222;border-radius:12px;padding:20px 24px;min-width:160px}.card-num{font-size:32px;font-weight:bold;color:#c8f060}.card-label{color:#666;font-size:12px;margin-top:4px;text-transform:uppercase;letter-spacing:1px}table{width:100%;border-collapse:collapse;background:#111;border-radius:12px;overflow:hidden}th{background:#1a1a1a;padding:12px 16px;text-align:left;font-size:11px;color:#666;letter-spacing:1px;text-transform:uppercase}td{padding:12px 16px;border-bottom:1px solid #1a1a1a;font-size:13px}tr:last-child td{border-bottom:none}a{color:#c8f060;text-decoration:none}.status{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:bold;text-transform:uppercase}.status-pending,.status-uploaded{background:#2a2a00;color:#ffcc00}.status-transcribing,.status-scoring{background:#00002a;color:#6666ff}.status-transcribed{background:#002a00;color:#00cc66}.status-scored{background:#0a2a0a;color:#c8f060}.status-failed{background:#2a0000;color:#ff4444}</style></head><body><h1>Aira Fitness - Consult Recorder</h1><p class="sub">Admin Dashboard</p><div class="cards"><div class="card"><div class="card-num">' +
        recordings.length +
        '</div><div class="card-label">Recordings</div></div><div class="card"><div class="card-num">' +
        scorecards.length +
        '</div><div class="card-label">Scorecards</div></div><div class="card"><div class="card-num">' +
        connectedTablets.length +
        '</div><div class="card-label">Tablets Online</div></div></div><table><thead><tr><th>Date</th><th>Location</th><th>Prospect</th><th>Duration</th><th>Status</th><th>Score</th><th>Audio</th><th>Scorecard</th></tr></thead><tbody>' +
        (rows ||
          '<tr><td colspan="7" style="text-align:center;color:#555;padding:40px">No recordings yet</td></tr>') +
        "</tbody></table><script>setTimeout(function(){location.reload()},30000);<\/script></body></html>",
    );
  } catch (err) {
    console.error("[Admin] Error:", err.message);
    res.status(500).send("Error loading admin: " + err.message);
  }
});

app.get("/scorecard/:id", async (req, res) => {
  try {
    const recordings = await db.getAllRecordings();
    const scorecards = await db.getAllScorecards();
    const r = recordings.find((x) => x.recording_id === req.params.id);
    if (!r) return res.status(404).send("Recording not found");
    const s = scorecards.find((x) => x.recording_id === req.params.id);
    if (!s)
      return res
        .status(404)
        .send(
          "Scorecard not yet available — check back after processing completes.",
        );
    const { byLocationId } = require("./locations");
    const loc = byLocationId[r.location_id] || {};
    const name = r.contact_name || r.appointment_id;
    const date = new Date(r.recorded_at).toLocaleDateString("en-US", {
      timeZone: "America/Chicago",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const scoreColor =
      s.total_score >= 80
        ? "#c8f060"
        : s.total_score >= 60
          ? "#f0c060"
          : "#ff6b6b";
    const sections = [
      ["Sit-Down Presentation", s.sitdown_score],
      ["Objection Handling", s.objection_score],
      ["Language & Delivery", s.language_score],
      ["The Close", s.close_score],
    ];
    res.send(`<!DOCTYPE html><html><head><title>Scorecard — ${name}</title><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:#0a0a0a;color:#f0f0f0;padding:32px;max-width:800px;margin:0 auto}
h1{color:#c8f060;font-size:22px;margin-bottom:4px}
.sub{color:#666;font-size:13px;margin-bottom:32px}
.score-big{font-size:56px;font-weight:bold;color:${scoreColor};line-height:1}
.summary{color:#ccc;font-size:15px;margin:16px 0 32px;line-height:1.6}
.scores-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:32px}
.section{background:#111;border:1px solid #222;border-radius:10px;padding:16px}
.sec-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.sec-label{color:#c8f060;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:1px}
.sec-score{color:#fff;font-size:18px;font-weight:bold}
.bar{background:#222;border-radius:4px;height:6px}
.bar-fill{height:6px;border-radius:4px;background:#c8f060}
.coaching-box{background:#111;border:1px solid #222;border-radius:10px;padding:20px;margin-bottom:24px}
.coaching-box h3{color:#c8f060;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
.coaching-box p{color:#bbb;font-size:13px;line-height:1.8;white-space:pre-wrap}
.transcript-box{background:#111;border:1px solid #222;border-radius:10px;padding:20px;margin-bottom:24px}
.transcript-box h3{color:#c8f060;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
.transcript-box p{color:#888;font-size:12px;line-height:1.8;white-space:pre-wrap;max-height:400px;overflow-y:auto}
.back{display:inline-block;color:#666;font-size:12px;text-decoration:none;margin-bottom:24px}
.back:hover{color:#c8f060}
.flag{display:inline-block;background:#ff000022;border:1px solid #ff4444;color:#ff4444;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:bold;margin-bottom:16px}
</style></head><body>
<a href="/admin" class="back">← Back to Admin</a>
${s.flagged_for_review ? '<div class="flag">⚠ Flagged for Review</div>' : ""}
<h1>${name}</h1>
<div class="sub">${loc.franchise_name || r.location_id} &nbsp;·&nbsp; ${date} &nbsp;·&nbsp; ${Math.round(r.duration_seconds / 60)}m ${r.duration_seconds % 60}s</div>
<div class="score-big">${s.total_score}<span style="font-size:24px;color:#666">/100</span></div>
<p class="summary">${s.ai_summary || ""}</p>
<div class="scores-grid">
${sections
  .map(
    ([label, score]) => `
<div class="section">
  <div class="sec-header">
    <span class="sec-label">${label}</span>
    <span class="sec-score">${score != null ? score + "/25" : "—"}</span>
  </div>
  <div class="bar"><div class="bar-fill" style="width:${score != null ? (score / 25) * 100 : 0}%"></div></div>
</div>`,
  )
  .join("")}
</div>
${s.coaching_note ? `<div class="coaching-box"><h3>Coaching Notes</h3><p>${s.coaching_note}</p></div>` : ""}
${r.transcript ? `<div class="transcript-box"><h3>Transcript</h3><p>${r.transcript}</p></div>` : ""}
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
  res.send(
    "<!DOCTYPE html><html><head><title>Playback</title><style>body{background:#0a0a0a;color:#f0f0f0;font-family:Arial;padding:32px}h2{color:#c8f060}</style></head><body><h2>Recording: " +
      name +
      '</h2><p style="color:#666;margin-bottom:16px">' +
      new Date(rec.recorded_at).toLocaleString("en-US", {
        timeZone: "America/Chicago",
      }) +
      '</p><audio controls style="width:100%;margin-bottom:24px"><source src="/audio/' +
      path.basename(rec.audio_file_url) +
      '"></audio>' +
      (rec.transcript
        ? '<h3 style="color:#888;margin-bottom:8px">Transcript</h3><p style="line-height:1.7;color:#ccc">' +
          rec.transcript +
          "</p>"
        : '<p style="color:#555">No transcript yet</p>') +
      '<p style="margin-top:16px"><a href="/admin" style="color:#c8f060">Back to admin</a></p></body></html>',
  );
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
