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

    // ─── Analytics ───
    // Every scorecard insert is preserved in the DB forever (no deletes anywhere — historical
    // re-scores stay around so we can use them for training, flashcards, regression testing).
    // For LIVE dashboard math we want one row per recording (the most recent), so rescores
    // don't double-count toward avg score / themes / leaderboard.
    const latestByRec = new Map();
    for (const sc of scorecards) {
      const prev = latestByRec.get(sc.recording_id);
      if (!prev || new Date(sc.created_at) > new Date(prev.created_at)) latestByRec.set(sc.recording_id, sc);
    }
    const scored = Array.from(latestByRec.values());
    const historicalScorecardCount = scorecards.length;  // includes every rescore — never lost

    const totalCloses = scored.filter((s) => s.did_close === true).length;
    const closeRate = scored.length ? Math.round((totalCloses / scored.length) * 100) : 0;
    const avgTotal = scored.length ? Math.round(scored.reduce((a, s) => a + (s.total_score || 0), 0) / scored.length) : 0;
    const avgCat = (key) => scored.length ? Math.round(scored.reduce((a, s) => a + (s[key] || 0), 0) / scored.length * 10) / 10 : 0;
    const catStats = [
      { label: "Sit-Down", avg: avgCat("sitdown_score"), key: "sitdown_score" },
      { label: "Objection Handling", avg: avgCat("objection_score"), key: "objection_score" },
      { label: "Language & Psychology", avg: avgCat("language_score"), key: "language_score" },
      { label: "Close Execution", avg: avgCat("close_score"), key: "close_score" },
    ].sort((a, b) => a.avg - b.avg);

    // ─── 30-day daily series (for sparklines) ───
    // Pair each latest scorecard with its recording date.
    const recById = new Map(recordings.map((r) => [r.recording_id, r]));
    const todayMs = Date.now();
    const DAY_MS = 86400000;
    const dailyScores = Array.from({ length: 30 }, () => []);
    const dailyClosed = Array.from({ length: 30 }, () => 0);
    const dailyTotal  = Array.from({ length: 30 }, () => 0);
    for (const sc of scored) {
      const rec = recById.get(sc.recording_id);
      if (!rec) continue;
      const ageDays = Math.floor((todayMs - new Date(rec.recorded_at).getTime()) / DAY_MS);
      if (ageDays < 0 || ageDays >= 30) continue;
      const idx = 29 - ageDays;  // oldest-on-left, today-on-right
      dailyScores[idx].push(sc.total_score || 0);
      dailyTotal[idx] += 1;
      if (sc.did_close === true) dailyClosed[idx] += 1;
    }
    const sparkScore = dailyScores.map((arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
    const sparkClose = dailyTotal.map((t, i) => t ? Math.round((dailyClosed[i] / t) * 100) : null);
    function sparklineSvg(series, color, width = 130, height = 32) {
      const pts = series.map((v, i) => ({ v, i }));
      const valid = pts.filter((p) => p.v !== null);
      if (valid.length === 0) return "";
      const min = Math.min(...valid.map((p) => p.v));
      const max = Math.max(...valid.map((p) => p.v));
      const range = max - min || 1;
      const xStep = width / (series.length - 1);
      const y = (v) => height - 4 - ((v - min) / range) * (height - 8);
      // Draw a continuous line through valid points; gaps span over null buckets
      const path = valid.map((p, i) => `${i === 0 ? "M" : "L"} ${(p.i * xStep).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
      const lastPt = valid[valid.length - 1];
      return `<svg width="${width}" height="${height}" style="display:block;margin-top:6px;overflow:visible;" viewBox="0 0 ${width} ${height}">
        <path d="${path}" stroke="${color}" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" />
        <circle cx="${(lastPt.i * xStep).toFixed(1)}" cy="${y(lastPt.v).toFixed(1)}" r="2.5" fill="${color}" />
      </svg>`;
    }

    // ─── Per-location leaderboard ───
    // Aggregate by location_id, hydrate with byLocationId for display name. Include locations
    // even with 0 scorecards if they have any recordings — VPs want to see all their gyms.
    const locStats = new Map();
    for (const r of recordings) {
      const k = r.location_id || "unknown";
      if (!locStats.has(k)) {
        const meta = byLocationId[k] || {};
        locStats.set(k, {
          location_id: k,
          franchise_name: meta.franchise_name || k,
          consults: 0, scoredCount: 0, scoreSum: 0, closeCount: 0, lastDate: null,
        });
      }
      const ls = locStats.get(k);
      ls.consults += 1;
      const sc = latestByRec.get(r.recording_id);
      if (sc) {
        ls.scoredCount += 1;
        ls.scoreSum += sc.total_score || 0;
        if (sc.did_close === true) ls.closeCount += 1;
      }
      const d = new Date(r.recorded_at).getTime();
      if (!ls.lastDate || d > ls.lastDate) ls.lastDate = d;
    }
    const leaderboard = Array.from(locStats.values()).map((l) => ({
      ...l,
      avgScore: l.scoredCount ? Math.round(l.scoreSum / l.scoredCount) : null,
      closeRate: l.scoredCount ? Math.round((l.closeCount / l.scoredCount) * 100) : null,
    })).sort((a, b) => {
      // Locations with data come first, weakest avg first; locations without data last.
      if (a.avgScore === null && b.avgScore === null) return b.consults - a.consults;
      if (a.avgScore === null) return 1;
      if (b.avgScore === null) return -1;
      return a.avgScore - b.avgScore;
    });
    const activeLocations = leaderboard.filter((l) => l.consults > 0).length;

    // Recurring coaching themes — keyword scan across overall_coaching + per-section coaching + explainers.
    // Each theme: a display name and an array of regex/phrase patterns. A scorecard counts ONCE per theme
    // even if multiple patterns match (so the count = # of consults exhibiting the issue).
    const themes = [
      { name: "Skipped 'Make sense?' close on sit-down", patterns: [/make sense\??\s*(close|check|micro)/i, /skipped (the )?['"]?make sense/i, /missed (the )?['"]?make sense/i, /didn'?t (say|use|land) ['"]?make sense/i] },
      { name: "Offered discount before isolating cost (skipped Deaf Ear)", patterns: [/(coupon|discount).{0,40}(too early|before.{0,30}(deaf ear|isolat))/i, /skipped (the )?deaf ear/i, /didn'?t run (the )?deaf ear/i, /led with (the )?(coupon|discount)/i, /jump(ed|ing) to (the )?coupon/i] },
      { name: "Permission-seeking instead of assumptive close", patterns: [/permission.?seeking/i, /['"]?(would|do) you (like to|want to)['"]?.{0,50}(instead|rather than|permission)/i, /not assumptive/i] },
      { name: "Accepted 'let me think about it' without re-closing", patterns: [/accept(ed|ing) ['"]?(let me think|I'?ll come back|I need to think)/i, /didn'?t re-?close/i, /let (her|him|them) walk/i, /didn'?t push back/i] },
      { name: "Didn't run tie-downs after buying signals", patterns: [/skipped (the )?tie.?down/i, /missed (the )?tie.?down/i, /didn'?t run (the )?tie.?down/i, /no tie.?down/i, /buying signal.{0,40}(missed|skipped|ignored)/i] },
      { name: "Didn't offer PIF after close", patterns: [/didn'?t (offer|run) (the )?pif/i, /skipped (the )?pif/i, /missed (the )?pif/i, /no pif (close|offer)/i] },
      { name: "Didn't collect referrals", patterns: [/didn'?t (collect|ask for|run) referrals?/i, /skipped (the )?referral/i, /missed (the )?referral/i, /no referral collect/i] },
      { name: "Closed (or attempted to) while standing", patterns: [/clos(ed|ing) (while )?standing/i, /didn'?t sit down/i, /never sat down/i, /standing close/i] },
      { name: "Used Google Review Drop too early", patterns: [/google review.{0,30}(too early|before.{0,30}(coupon|deaf ear))/i, /jump(ed|ing) to (the )?google review/i, /led with (the )?google review/i] },
      { name: "Didn't present all 3 tiers", patterns: [/didn'?t (present|show) all (3|three) tiers/i, /skipped (a )?tier/i, /only (presented|showed) (one|two)/i, /missed (a )?tier/i] },
      { name: "Skipped 'By The Way' close on free pass", patterns: [/skipped (the )?by the way/i, /missed (the )?by the way/i, /didn'?t use (the )?by the way/i, /no by the way close/i] },
    ];
    const themeCounts = themes.map((t) => {
      let count = 0;
      for (const sc of scored) {
        const hay = [
          sc.overall_coaching, sc.coaching_note, sc.process_warning,
          sc.sitdown_score_explainer, sc.objection_score_explainer, sc.language_score_explainer, sc.close_score_explainer,
          sc.sitdown_coaching, sc.objection_coaching, sc.language_coaching, sc.close_coaching,
        ].filter(Boolean).join(" ");
        if (t.patterns.some((p) => p.test(hay))) count++;
      }
      const pct = scored.length ? Math.round((count / scored.length) * 100) : 0;
      return { name: t.name, count, pct };
    }).filter((t) => t.count > 0).sort((a, b) => b.count - a.count).slice(0, 8);

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
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:24px 0 20px;}
.kpi{padding:16px 18px;}
.kpi-label{font-size:10px;font-weight:800;color:#6B7280;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;}
.kpi-num{font-size:30px;font-weight:900;color:#00AEEF;line-height:1.1;letter-spacing:-.02em;}
.kpi-foot{font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.1em;margin-top:6px;}
.leaderboard{margin-bottom:20px;padding:20px 22px;}
.lb-table{width:100%;border-collapse:collapse;margin-top:6px;}
.lb-table th{background:transparent;padding:10px 12px;font-size:10px;color:#6B7280;font-weight:800;text-transform:uppercase;letter-spacing:.12em;border-bottom:1px solid #E5E7EB;text-align:center;}
.lb-table td{padding:14px 12px;border-bottom:1px solid #F3F4F6;text-align:center;vertical-align:middle;}
.lb-table tr:last-child td{border-bottom:none;}
.lb-table tr:hover{background:#F9FAFB;}
.tablets-list{font-size:11px;color:#6B7280;margin-top:6px;}
.insights{display:grid;grid-template-columns:1fr 1.4fr;gap:16px;margin-bottom:24px;}
@media(max-width:880px){.insights{grid-template-columns:1fr;}}
.panel{padding:20px 22px;}
.panel-header{margin-bottom:14px;}
.panel-eyebrow{font-size:10px;font-weight:800;color:#0A0A0A;text-transform:uppercase;letter-spacing:.14em;}
.panel-sub{font-size:12px;color:#6B7280;margin-top:4px;}
.panel-empty{font-size:13px;color:#9CA3AF;padding:18px 0;text-align:center;}
.cat-row{margin-top:14px;}
.cat-row:first-of-type{margin-top:6px;}
.cat-row-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;}
.cat-label{font-size:13px;font-weight:700;color:#111827;}
.cat-score{font-size:14px;font-weight:800;}
.cat-bar{background:#F3F4F6;border-radius:9999px;height:6px;overflow:hidden;}
.cat-bar-fill{height:6px;border-radius:9999px;}
.theme-row{display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid #F3F4F6;}
.theme-row:last-child{border-bottom:none;}
.theme-rank{font-size:18px;font-weight:900;width:22px;flex-shrink:0;text-align:center;}
.theme-body{flex:1;min-width:0;}
.theme-name{font-size:13px;font-weight:700;color:#111827;margin-bottom:5px;line-height:1.3;}
.theme-bar{background:#F3F4F6;border-radius:9999px;height:4px;overflow:hidden;}
.theme-bar-fill{height:4px;border-radius:9999px;}
.theme-count{font-size:16px;font-weight:900;flex-shrink:0;text-align:right;min-width:60px;}
.section-eyebrow{font-size:10px;font-weight:800;color:#6B7280;text-transform:uppercase;letter-spacing:.14em;margin:8px 0 10px 4px;}

.card{background:#fff;border:1px solid #E5E7EB;border-radius:10px;}
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
  <div class="kpi-grid">
    <div class="card kpi"><div class="kpi-label">Recordings</div><div class="kpi-num">${recordings.length}</div></div>
    <div class="card kpi"><div class="kpi-label">Scorecards</div><div class="kpi-num">${scored.length}</div><div class="kpi-foot">${historicalScorecardCount} total in history</div></div>
    <div class="card kpi"><div class="kpi-label">Total Closes</div><div class="kpi-num">${totalCloses}</div></div>
    <div class="card kpi">
      <div class="kpi-label">Close Rate</div>
      <div class="kpi-num" style="color:${closeRate >= 30 ? "#00AEEF" : closeRate >= 15 ? "#0284C7" : "#DC2626"};">${closeRate}<span style="font-size:18px;color:#9CA3AF;font-weight:600;">%</span></div>
      ${sparklineSvg(sparkClose, closeRate >= 30 ? "#00AEEF" : closeRate >= 15 ? "#0284C7" : "#DC2626")}
      <div class="kpi-foot">last 30 days</div>
    </div>
    <div class="card kpi">
      <div class="kpi-label">Avg Score</div>
      <div class="kpi-num" style="color:${avgTotal >= 70 ? "#00AEEF" : avgTotal >= 50 ? "#0284C7" : "#DC2626"};">${avgTotal}<span style="font-size:18px;color:#9CA3AF;font-weight:600;"> / 100</span></div>
      ${sparklineSvg(sparkScore, avgTotal >= 70 ? "#00AEEF" : avgTotal >= 50 ? "#0284C7" : "#DC2626")}
      <div class="kpi-foot">last 30 days</div>
    </div>
    <div class="card kpi tablets-card"><div class="kpi-label">Tablets Online</div><div class="kpi-num" style="color:${connectedTablets.length > 0 ? "#00AEEF" : "#9CA3AF"};">${connectedTablets.length}</div>${connectedTablets.length ? `<div class="tablets-list">${connectedTablets.join(", ")}</div>` : ""}</div>
  </div>

  <div class="card panel leaderboard">
    <div class="panel-header">
      <div class="panel-eyebrow">Per-Location Leaderboard</div>
      <div class="panel-sub">${activeLocations} active location${activeLocations === 1 ? "" : "s"} — weakest avg score first. Click a row to filter.</div>
    </div>
    ${leaderboard.length === 0 ? '<div class="panel-empty">No locations recorded yet.</div>' : `
    <table class="lb-table">
      <thead><tr>
        <th style="text-align:left;">Location</th>
        <th>Consults</th>
        <th>Closes</th>
        <th>Close %</th>
        <th>Avg Score</th>
        <th>Last Activity</th>
      </tr></thead>
      <tbody>
      ${leaderboard.map((l) => {
        const scoreColor = l.avgScore === null ? "#9CA3AF" : l.avgScore >= 70 ? "#00AEEF" : l.avgScore >= 50 ? "#0284C7" : "#DC2626";
        const rateColor = l.closeRate === null ? "#9CA3AF" : l.closeRate >= 30 ? "#00AEEF" : l.closeRate >= 15 ? "#0284C7" : "#DC2626";
        const lastDate = l.lastDate ? new Date(l.lastDate).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" }) : "—";
        return `<tr>
          <td style="text-align:left;">
            <div style="font-size:13px;font-weight:700;color:#111827;">${l.franchise_name}</div>
            <div style="font-size:11px;color:#6B7280;">${l.location_id}</div>
          </td>
          <td><span style="font-size:14px;font-weight:700;color:#111827;">${l.consults}</span></td>
          <td><span style="font-size:14px;font-weight:700;color:#111827;">${l.closeCount}</span></td>
          <td>${l.closeRate === null ? '<span style="color:#D1D5DB;">—</span>' : `<span style="font-size:13px;font-weight:800;color:${rateColor};">${l.closeRate}%</span>`}</td>
          <td>${l.avgScore === null ? '<span style="color:#D1D5DB;">—</span>' : `<span style="font-size:14px;font-weight:800;color:${scoreColor};">${l.avgScore}<span style="font-size:11px;color:#9CA3AF;font-weight:600;"> /100</span></span>`}</td>
          <td><span style="font-size:12px;color:#6B7280;">${lastDate}</span></td>
        </tr>`;
      }).join("")}
      </tbody>
    </table>`}
  </div>

  <div class="insights">
    <div class="card panel">
      <div class="panel-header">
        <div class="panel-eyebrow">Average Score by Category</div>
        <div class="panel-sub">${scored.length} scored consult${scored.length === 1 ? "" : "s"} — weakest categories first</div>
      </div>
      ${scored.length === 0 ? '<div class="panel-empty">No scored consults yet.</div>' : catStats.map((c) => {
        const pct = (c.avg / 25) * 100;
        const color = pct >= 80 ? "#00AEEF" : pct >= 60 ? "#0284C7" : "#DC2626";
        return `<div class="cat-row">
          <div class="cat-row-head">
            <div class="cat-label">${c.label}</div>
            <div class="cat-score" style="color:${color};">${c.avg}<span style="color:#9CA3AF;font-weight:600;"> / 25</span></div>
          </div>
          <div class="cat-bar"><div class="cat-bar-fill" style="background:${color};width:${pct}%;"></div></div>
        </div>`;
      }).join("")}
    </div>

    <div class="card panel">
      <div class="panel-header">
        <div class="panel-eyebrow">Top Coaching Themes</div>
        <div class="panel-sub">Recurring mistakes detected across coaching notes — train these first</div>
      </div>
      ${themeCounts.length === 0 ? '<div class="panel-empty">No recurring themes detected yet.</div>' : themeCounts.map((t, i) => {
        const sev = t.pct >= 50 ? "#DC2626" : t.pct >= 25 ? "#0284C7" : "#00AEEF";
        return `<div class="theme-row">
          <div class="theme-rank" style="color:${sev};">${i + 1}</div>
          <div class="theme-body">
            <div class="theme-name">${t.name}</div>
            <div class="theme-bar"><div class="theme-bar-fill" style="background:${sev};width:${t.pct}%;"></div></div>
          </div>
          <div class="theme-count" style="color:${sev};">${t.count}<span style="color:#9CA3AF;font-weight:600;font-size:11px;"> / ${scored.length}</span></div>
        </div>`;
      }).join("")}
    </div>
  </div>

  <div class="section-eyebrow">All Recordings</div>
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
