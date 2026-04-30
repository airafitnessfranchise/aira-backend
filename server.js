// server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const {
  byCalendarId,
  byLocationId,
  canonicalLocationId,
  locations: ALL_LOCATIONS,
} = require("./locations");
const { initDb, ...db } = require("./db");
const {
  transcribeAudio,
  scoreTranscript,
  PROSPECT_PERSONAS,
  startPracticeSession,
  chatAsProspect,
  getPracticeSession,
  scorePracticeSession,
  GAME_LEVELS,
  findScenarioById,
} = require("./ai");
const { sendScorecardEmail, sendPracticeEmail } = require("./email");
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

// HTTP Basic Auth middleware for the admin browser pages.
// Default password "airafitness" — override by setting ADMIN_PASSWORD in Railway env.
// Username is always "admin".
function adminAuth(req, res, next) {
  const password = process.env.ADMIN_PASSWORD || "airafitness";
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
    if (user === "admin" && pass === password) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Aira Admin"');
  return res.status(401).send("Authentication required");
}

// ─────────── Date range helper for /admin and /admin/location/:id ───────────
// Accepts ?range=this_month|last_month|30d|90d|all|custom (+ ?from=&to= for custom).
// Returns the current window AND a previous-period window for delta comparison.
function parseRange(req) {
  const range = String(req.query.range || "all").toLowerCase();
  const now = new Date();
  const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
  let from = null,
    to = null,
    prevFrom = null,
    prevTo = null,
    label = "All Time",
    prevLabel = null;

  if (range === "this_month") {
    from = startOfMonth(now);
    to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    prevTo = from;
    label = "This Month";
    prevLabel = "vs last month";
  } else if (range === "last_month") {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    to = startOfMonth(now);
    prevFrom = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    prevTo = from;
    label = "Last Month";
    prevLabel = "vs the month before";
  } else if (range === "30d") {
    to = now;
    from = new Date(now.getTime() - 30 * 86400000);
    prevTo = from;
    prevFrom = new Date(prevTo.getTime() - 30 * 86400000);
    label = "Last 30 Days";
    prevLabel = "vs prior 30 days";
  } else if (range === "90d") {
    to = now;
    from = new Date(now.getTime() - 90 * 86400000);
    prevTo = from;
    prevFrom = new Date(prevTo.getTime() - 90 * 86400000);
    label = "Last 90 Days";
    prevLabel = "vs prior 90 days";
  } else if (range === "custom" && req.query.from && req.query.to) {
    from = new Date(req.query.from);
    to = new Date(new Date(req.query.to).getTime() + 86400000); // inclusive end
    const span = to - from;
    prevTo = from;
    prevFrom = new Date(from.getTime() - span);
    label = `${req.query.from} → ${req.query.to}`;
    prevLabel = "vs prior period";
  }

  const inRange = (d) => {
    if (!from || !to) return true;
    const t = new Date(d).getTime();
    return t >= from.getTime() && t < to.getTime();
  };
  const inPrev = (d) => {
    if (!prevFrom || !prevTo) return false;
    const t = new Date(d).getTime();
    return t >= prevFrom.getTime() && t < prevTo.getTime();
  };

  return {
    range,
    from,
    to,
    prevFrom,
    prevTo,
    label,
    prevLabel,
    inRange,
    inPrev,
  };
}

// Renders the pill bar for switching ranges. Active pill is colored.
function rangeSelectorHtml(currentRange, baseUrl) {
  const opts = [
    { v: "this_month", label: "This Month" },
    { v: "last_month", label: "Last Month" },
    { v: "30d", label: "30 Days" },
    { v: "90d", label: "90 Days" },
    { v: "all", label: "All Time" },
  ];
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `<div class="range-bar">
    ${opts
      .map((o) => {
        const active = o.v === currentRange;
        const url = `${baseUrl}${sep}range=${o.v}`;
        return `<a href="${url}" class="range-pill${active ? " active" : ""}">${o.label}</a>`;
      })
      .join("")}
  </div>`;
}

// Render a delta vs previous period as an arrow + signed number.
function deltaHtml(current, prev, suffix = "", invert = false) {
  if (prev === null || prev === undefined) return "";
  const diff = current - prev;
  if (diff === 0) return `<div class="kpi-delta neutral">no change</div>`;
  const isUp = diff > 0;
  const isGood = invert ? !isUp : isUp;
  const cls = isGood ? "good" : "bad";
  const arrow = isUp ? "↑" : "↓";
  const sign = isUp ? "+" : "";
  return `<div class="kpi-delta ${cls}">${arrow} ${sign}${diff}${suffix}</div>`;
}

app.get("/admin", adminAuth, async (req, res) => {
  try {
    const recordings = await db.getAllRecordings();
    const scorecards = await db.getAllScorecards();
    const scorecardMap = {};
    scorecards.forEach((s) => {
      scorecardMap[s.recording_id] = s;
    });
    const connectedTablets = Array.from(tabletConnections.keys());

    // ─── Date range filter (with previous-period comparison) ───
    const period = parseRange(req);

    // ─── Analytics ───
    // Every scorecard insert is preserved in the DB forever. For LIVE dashboard math
    // we want one row per recording (the most recent), so rescores don't double-count.
    const latestByRec = new Map();
    for (const sc of scorecards) {
      const prev = latestByRec.get(sc.recording_id);
      if (!prev || new Date(sc.created_at) > new Date(prev.created_at))
        latestByRec.set(sc.recording_id, sc);
    }
    const allScored = Array.from(latestByRec.values());
    const historicalScorecardCount = scorecards.length;

    // Filter scored to current period (by the recording's recorded_at date).
    const recDateById = new Map(
      recordings.map((r) => [r.recording_id, r.recorded_at]),
    );
    const scoredInPeriod = (sc) => {
      const d = recDateById.get(sc.recording_id);
      return d ? period.inRange(d) : true;
    };
    const scoredInPrev = (sc) => {
      const d = recDateById.get(sc.recording_id);
      return d ? period.inPrev(d) : false;
    };
    const scored = allScored.filter(scoredInPeriod);
    const scoredPrev = allScored.filter(scoredInPrev);

    // Recordings filtered to the current period (used for per-location leaderboard, table)
    const recordingsInPeriod = recordings.filter((r) =>
      period.inRange(r.recorded_at),
    );
    const recordingsPrev = recordings.filter((r) =>
      period.inPrev(r.recorded_at),
    );

    const totalCloses = scored.filter((s) => s.did_close === true).length;
    const closeRate = scored.length
      ? Math.round((totalCloses / scored.length) * 100)
      : 0;
    const avgTotal = scored.length
      ? Math.round(
          scored.reduce((a, s) => a + (s.total_score || 0), 0) / scored.length,
        )
      : 0;
    const avgCat = (key, list) =>
      list.length
        ? Math.round(
            (list.reduce((a, s) => a + (s[key] || 0), 0) / list.length) * 10,
          ) / 10
        : 0;
    const catStats = [
      {
        label: "Sit-Down",
        avg: avgCat("sitdown_score", scored),
        key: "sitdown_score",
      },
      {
        label: "Objection Handling",
        avg: avgCat("objection_score", scored),
        key: "objection_score",
      },
      {
        label: "Language & Psychology",
        avg: avgCat("language_score", scored),
        key: "language_score",
      },
      {
        label: "Close Execution",
        avg: avgCat("close_score", scored),
        key: "close_score",
      },
    ].sort((a, b) => a.avg - b.avg);

    // Previous-period stats for delta comparison (only when a non-all range is active)
    const prevTotalCloses = scoredPrev.filter(
      (s) => s.did_close === true,
    ).length;
    const prevCloseRate = scoredPrev.length
      ? Math.round((prevTotalCloses / scoredPrev.length) * 100)
      : null;
    const prevAvgTotal = scoredPrev.length
      ? Math.round(
          scoredPrev.reduce((a, s) => a + (s.total_score || 0), 0) /
            scoredPrev.length,
        )
      : null;
    const showDeltas = period.range !== "all" && period.prevLabel;

    // ─── 30-day daily series (for sparklines) ───
    // Pair each latest scorecard with its recording date.
    const recById = new Map(recordings.map((r) => [r.recording_id, r]));
    const todayMs = Date.now();
    const DAY_MS = 86400000;
    const dailyScores = Array.from({ length: 30 }, () => []);
    const dailyClosed = Array.from({ length: 30 }, () => 0);
    const dailyTotal = Array.from({ length: 30 }, () => 0);
    for (const sc of scored) {
      const rec = recById.get(sc.recording_id);
      if (!rec) continue;
      const ageDays = Math.floor(
        (todayMs - new Date(rec.recorded_at).getTime()) / DAY_MS,
      );
      if (ageDays < 0 || ageDays >= 30) continue;
      const idx = 29 - ageDays; // oldest-on-left, today-on-right
      dailyScores[idx].push(sc.total_score || 0);
      dailyTotal[idx] += 1;
      if (sc.did_close === true) dailyClosed[idx] += 1;
    }
    const sparkScore = dailyScores.map((arr) =>
      arr.length
        ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
        : null,
    );
    const sparkClose = dailyTotal.map((t, i) =>
      t ? Math.round((dailyClosed[i] / t) * 100) : null,
    );
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
      const path = valid
        .map(
          (p, i) =>
            `${i === 0 ? "M" : "L"} ${(p.i * xStep).toFixed(1)} ${y(p.v).toFixed(1)}`,
        )
        .join(" ");
      const lastPt = valid[valid.length - 1];
      return `<svg width="${width}" height="${height}" style="display:block;margin-top:6px;overflow:visible;" viewBox="0 0 ${width} ${height}">
        <path d="${path}" stroke="${color}" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" />
        <circle cx="${(lastPt.i * xStep).toFixed(1)}" cy="${y(lastPt.v).toFixed(1)}" r="2.5" fill="${color}" />
      </svg>`;
    }

    // ─── Per-location leaderboard ───
    // Aggregate by location_id, scoped to the selected period.
    const locStats = new Map();
    for (const r of recordingsInPeriod) {
      const k = canonicalLocationId(r.location_id) || "unknown";
      if (!locStats.has(k)) {
        const meta = byLocationId[k] || {};
        locStats.set(k, {
          location_id: k,
          franchise_name: meta.franchise_name || k,
          consults: 0,
          scoredCount: 0,
          scoreSum: 0,
          closeCount: 0,
          lastDate: null,
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
    const leaderboard = Array.from(locStats.values())
      .map((l) => ({
        ...l,
        avgScore: l.scoredCount ? Math.round(l.scoreSum / l.scoredCount) : null,
        closeRate: l.scoredCount
          ? Math.round((l.closeCount / l.scoredCount) * 100)
          : null,
      }))
      .sort((a, b) => {
        // Locations with data come first, weakest avg first; locations without data last.
        if (a.avgScore === null && b.avgScore === null)
          return b.consults - a.consults;
        if (a.avgScore === null) return 1;
        if (b.avgScore === null) return -1;
        return a.avgScore - b.avgScore;
      });
    const activeLocations = leaderboard.filter((l) => l.consults > 0).length;

    // Recurring coaching themes — keyword scan across overall_coaching + per-section coaching + explainers.
    // Each theme: a display name and an array of regex/phrase patterns. A scorecard counts ONCE per theme
    // even if multiple patterns match (so the count = # of consults exhibiting the issue).
    const themes = [
      {
        name: "Skipped 'Make sense?' close on sit-down",
        patterns: [
          /make sense\??\s*(close|check|micro)/i,
          /skipped (the )?['"]?make sense/i,
          /missed (the )?['"]?make sense/i,
          /didn'?t (say|use|land) ['"]?make sense/i,
        ],
      },
      {
        name: "Offered discount before isolating cost (skipped Deaf Ear)",
        patterns: [
          /(coupon|discount).{0,40}(too early|before.{0,30}(deaf ear|isolat))/i,
          /skipped (the )?deaf ear/i,
          /didn'?t run (the )?deaf ear/i,
          /led with (the )?(coupon|discount)/i,
          /jump(ed|ing) to (the )?coupon/i,
        ],
      },
      {
        name: "Permission-seeking instead of assumptive close",
        patterns: [
          /permission.?seeking/i,
          /['"]?(would|do) you (like to|want to)['"]?.{0,50}(instead|rather than|permission)/i,
          /not assumptive/i,
        ],
      },
      {
        name: "Accepted 'let me think about it' without re-closing",
        patterns: [
          /accept(ed|ing) ['"]?(let me think|I'?ll come back|I need to think)/i,
          /didn'?t re-?close/i,
          /let (her|him|them) walk/i,
          /didn'?t push back/i,
        ],
      },
      {
        name: "Didn't run tie-downs after buying signals",
        patterns: [
          /skipped (the )?tie.?down/i,
          /missed (the )?tie.?down/i,
          /didn'?t run (the )?tie.?down/i,
          /no tie.?down/i,
          /buying signal.{0,40}(missed|skipped|ignored)/i,
        ],
      },
      {
        name: "Didn't offer PIF after close",
        patterns: [
          /didn'?t (offer|run) (the )?pif/i,
          /skipped (the )?pif/i,
          /missed (the )?pif/i,
          /no pif (close|offer)/i,
        ],
      },
      {
        name: "Didn't collect referrals",
        patterns: [
          /didn'?t (collect|ask for|run) referrals?/i,
          /skipped (the )?referral/i,
          /missed (the )?referral/i,
          /no referral collect/i,
        ],
      },
      {
        name: "Closed (or attempted to) while standing",
        patterns: [
          /clos(ed|ing) (while )?standing/i,
          /didn'?t sit down/i,
          /never sat down/i,
          /standing close/i,
        ],
      },
      {
        name: "Used Google Review Drop too early",
        patterns: [
          /google review.{0,30}(too early|before.{0,30}(coupon|deaf ear))/i,
          /jump(ed|ing) to (the )?google review/i,
          /led with (the )?google review/i,
        ],
      },
      {
        name: "Didn't present all 3 tiers",
        patterns: [
          /didn'?t (present|show) all (3|three) tiers/i,
          /skipped (a )?tier/i,
          /only (presented|showed) (one|two)/i,
          /missed (a )?tier/i,
        ],
      },
      {
        name: "Skipped 'By The Way' close on free pass",
        patterns: [
          /skipped (the )?by the way/i,
          /missed (the )?by the way/i,
          /didn'?t use (the )?by the way/i,
          /no by the way close/i,
        ],
      },
    ];
    const themeCounts = themes
      .map((t) => {
        let count = 0;
        for (const sc of scored) {
          const hay = [
            sc.overall_coaching,
            sc.coaching_note,
            sc.process_warning,
            sc.sitdown_score_explainer,
            sc.objection_score_explainer,
            sc.language_score_explainer,
            sc.close_score_explainer,
            sc.sitdown_coaching,
            sc.objection_coaching,
            sc.language_coaching,
            sc.close_coaching,
          ]
            .filter(Boolean)
            .join(" ");
          if (t.patterns.some((p) => p.test(hay))) count++;
        }
        const pct = scored.length
          ? Math.round((count / scored.length) * 100)
          : 0;
        return { name: t.name, count, pct };
      })
      .filter((t) => t.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const fmtDate = (d) =>
      new Date(d).toLocaleString("en-US", {
        timeZone: "America/Chicago",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    const fmtDuration = (sec) => Math.round(sec / 60) + "m " + (sec % 60) + "s";

    const scorePill = (sc) => {
      if (!sc) return '<span style="color:#9CA3AF;font-size:12px;">—</span>';
      const score = sc.total_score;
      const color =
        score >= 70 ? "#00AEEF" : score >= 50 ? "#0284C7" : "#DC2626";
      return `<a href="/scorecard/${sc.recording_id}" target="_blank" style="display:inline-block;padding:4px 10px;background:#fff;border:1.5px solid ${color};color:${color};border-radius:9999px;font-size:12px;font-weight:800;text-decoration:none;letter-spacing:.02em;">${score}<span style="color:#9CA3AF;font-weight:600;"> / 100</span></a>`;
    };

    const statusPill = (status) => {
      const s = status || "pending";
      let bg = "#F3F4F6",
        color = "#6B7280",
        border = "#E5E7EB";
      if (s === "transcribing" || s === "scoring" || s === "transcribed") {
        bg = "#E0F4FB";
        color = "#0284C7";
        border = "#BAE6FD";
      } else if (s === "scored") {
        bg = "#0A0A0A";
        color = "#fff";
        border = "#0A0A0A";
      } else if (s === "failed") {
        bg = "#FEE2E2";
        color = "#DC2626";
        border = "#FECACA";
      }
      return `<span style="display:inline-block;padding:3px 10px;background:${bg};color:${color};border:1px solid ${border};border-radius:9999px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">${s}</span>`;
    };

    const rows = recordingsInPeriod
      .map((r) => {
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
      })
      .join("");

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
.kpi-delta{font-size:11px;font-weight:800;letter-spacing:.04em;margin-top:8px;display:inline-block;padding:2px 8px;border-radius:9999px;}
.kpi-delta.good{background:#ECFDF5;color:#15803d;}
.kpi-delta.bad{background:#FEF3F2;color:#DC2626;}
.kpi-delta.neutral{background:#F3F4F6;color:#6B7280;}
.range-bar{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 14px;}
.range-pill{display:inline-block;padding:7px 14px;background:#fff;border:1px solid #E5E7EB;color:#374151;border-radius:9999px;font-size:12px;font-weight:700;text-decoration:none;letter-spacing:.02em;transition:all .15s;}
.range-pill:hover{border-color:#0284C7;color:#0284C7;}
.range-pill.active{background:#0A0A0A;color:#fff;border-color:#0A0A0A;}
.period-banner{font-size:12px;color:#6B7280;margin-bottom:18px;padding:0 4px;}
.period-banner b{color:#0A0A0A;font-weight:800;}
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
  <div class="subtitle">Live view of all consultation recordings and scoring &nbsp;·&nbsp; <a href="/admin/library" style="color:#00AEEF;font-weight:700;text-decoration:none;">Training Library →</a> &nbsp;·&nbsp; <a href="/admin/locations" style="color:#00AEEF;font-weight:700;text-decoration:none;">Locations →</a> &nbsp;·&nbsp; <a href="/practice" style="color:#00AEEF;font-weight:700;text-decoration:none;">Practice Bot →</a></div>
</div></div>
<div class="wrap">
  ${rangeSelectorHtml(period.range, "/admin")}
  <div class="period-banner">Showing: <b>${period.label}</b>${showDeltas ? ` &nbsp;·&nbsp; <span style="color:#9CA3AF;">comparing ${period.prevLabel}</span>` : ""}</div>

  <div class="kpi-grid">
    <div class="card kpi"><div class="kpi-label">Recordings</div><div class="kpi-num">${recordingsInPeriod.length}</div>${showDeltas ? deltaHtml(recordingsInPeriod.length, recordingsPrev.length) : ""}</div>
    <div class="card kpi"><div class="kpi-label">Scorecards</div><div class="kpi-num">${scored.length}</div>${showDeltas ? deltaHtml(scored.length, scoredPrev.length) : `<div class="kpi-foot">${historicalScorecardCount} total in history</div>`}</div>
    <div class="card kpi"><div class="kpi-label">Total Closes</div><div class="kpi-num">${totalCloses}</div>${showDeltas ? deltaHtml(totalCloses, prevTotalCloses) : ""}</div>
    <div class="card kpi">
      <div class="kpi-label">Close Rate</div>
      <div class="kpi-num" style="color:${closeRate >= 30 ? "#00AEEF" : closeRate >= 15 ? "#0284C7" : "#DC2626"};">${closeRate}<span style="font-size:18px;color:#9CA3AF;font-weight:600;">%</span></div>
      ${showDeltas ? deltaHtml(closeRate, prevCloseRate, "%") : sparklineSvg(sparkClose, closeRate >= 30 ? "#00AEEF" : closeRate >= 15 ? "#0284C7" : "#DC2626") + '<div class="kpi-foot">last 30 days</div>'}
    </div>
    <div class="card kpi">
      <div class="kpi-label">Avg Score</div>
      <div class="kpi-num" style="color:${avgTotal >= 70 ? "#00AEEF" : avgTotal >= 50 ? "#0284C7" : "#DC2626"};">${avgTotal}<span style="font-size:18px;color:#9CA3AF;font-weight:600;"> / 100</span></div>
      ${showDeltas ? deltaHtml(avgTotal, prevAvgTotal) : sparklineSvg(sparkScore, avgTotal >= 70 ? "#00AEEF" : avgTotal >= 50 ? "#0284C7" : "#DC2626") + '<div class="kpi-foot">last 30 days</div>'}
    </div>
    <div class="card kpi tablets-card"><div class="kpi-label">Tablets Online</div><div class="kpi-num" style="color:${connectedTablets.length > 0 ? "#00AEEF" : "#9CA3AF"};">${connectedTablets.length}</div>${connectedTablets.length ? `<div class="tablets-list">${connectedTablets.join(", ")}</div>` : ""}</div>
  </div>

  <div class="card panel leaderboard">
    <div class="panel-header">
      <div class="panel-eyebrow">Per-Location Leaderboard</div>
      <div class="panel-sub">${activeLocations} active location${activeLocations === 1 ? "" : "s"} — weakest avg score first. Click any row to open that gym's dashboard.</div>
    </div>
    ${
      leaderboard.length === 0
        ? '<div class="panel-empty">No locations recorded yet.</div>'
        : `
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
      ${leaderboard
        .map((l) => {
          const scoreColor =
            l.avgScore === null
              ? "#9CA3AF"
              : l.avgScore >= 70
                ? "#00AEEF"
                : l.avgScore >= 50
                  ? "#0284C7"
                  : "#DC2626";
          const rateColor =
            l.closeRate === null
              ? "#9CA3AF"
              : l.closeRate >= 30
                ? "#00AEEF"
                : l.closeRate >= 15
                  ? "#0284C7"
                  : "#DC2626";
          const lastDate = l.lastDate
            ? new Date(l.lastDate).toLocaleDateString("en-US", {
                timeZone: "America/Chicago",
                month: "short",
                day: "numeric",
              })
            : "—";
          const href = `/admin/location/${encodeURIComponent(l.location_id)}?range=${period.range}`;
          return `<tr style="cursor:pointer;" onclick="window.location='${href}'" title="View ${l.franchise_name} dashboard">
          <td style="text-align:left;">
            <div style="font-size:13px;font-weight:700;color:#0284C7;">${l.franchise_name} <span style="color:#9CA3AF;font-weight:600;">→</span></div>
            <div style="font-size:11px;color:#6B7280;">${l.location_id}</div>
          </td>
          <td><span style="font-size:14px;font-weight:700;color:#111827;">${l.consults}</span></td>
          <td><span style="font-size:14px;font-weight:700;color:#111827;">${l.closeCount}</span></td>
          <td>${l.closeRate === null ? '<span style="color:#D1D5DB;">—</span>' : `<span style="font-size:13px;font-weight:800;color:${rateColor};">${l.closeRate}%</span>`}</td>
          <td>${l.avgScore === null ? '<span style="color:#D1D5DB;">—</span>' : `<span style="font-size:14px;font-weight:800;color:${scoreColor};">${l.avgScore}<span style="font-size:11px;color:#9CA3AF;font-weight:600;"> /100</span></span>`}</td>
          <td><span style="font-size:12px;color:#6B7280;">${lastDate}</span></td>
        </tr>`;
        })
        .join("")}
      </tbody>
    </table>`
    }
  </div>

  <div class="insights">
    <div class="card panel">
      <div class="panel-header">
        <div class="panel-eyebrow">Average Score by Category</div>
        <div class="panel-sub">${scored.length} scored consult${scored.length === 1 ? "" : "s"} — weakest categories first</div>
      </div>
      ${
        scored.length === 0
          ? '<div class="panel-empty">No scored consults yet.</div>'
          : catStats
              .map((c) => {
                const pct = (c.avg / 25) * 100;
                const color =
                  pct >= 80 ? "#00AEEF" : pct >= 60 ? "#0284C7" : "#DC2626";
                return `<div class="cat-row">
          <div class="cat-row-head">
            <div class="cat-label">${c.label}</div>
            <div class="cat-score" style="color:${color};">${c.avg}<span style="color:#9CA3AF;font-weight:600;"> / 25</span></div>
          </div>
          <div class="cat-bar"><div class="cat-bar-fill" style="background:${color};width:${pct}%;"></div></div>
        </div>`;
              })
              .join("")
      }
    </div>

    <div class="card panel">
      <div class="panel-header">
        <div class="panel-eyebrow">Top Coaching Themes</div>
        <div class="panel-sub">Recurring mistakes detected across coaching notes — train these first</div>
      </div>
      ${
        themeCounts.length === 0
          ? '<div class="panel-empty">No recurring themes detected yet.</div>'
          : themeCounts
              .map((t, i) => {
                const sev =
                  t.pct >= 50 ? "#DC2626" : t.pct >= 25 ? "#0284C7" : "#00AEEF";
                return `<div class="theme-row">
          <div class="theme-rank" style="color:${sev};">${i + 1}</div>
          <div class="theme-body">
            <div class="theme-name">${t.name}</div>
            <div class="theme-bar"><div class="theme-bar-fill" style="background:${sev};width:${t.pct}%;"></div></div>
          </div>
          <div class="theme-count" style="color:${sev};">${t.count}<span style="color:#9CA3AF;font-weight:600;font-size:11px;"> / ${scored.length}</span></div>
        </div>`;
              })
              .join("")
      }
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

// ─────────── /admin/locations — add gyms without touching code ───────────

app.get("/admin/locations", adminAuth, async (req, res) => {
  const customs = await db.getCustomLocations();
  const allLocs = ALL_LOCATIONS.slice().sort((a, b) =>
    (a.franchise_name || "").localeCompare(b.franchise_name || ""),
  );
  const addedSlug = req.query.added_slug
    ? decodeURIComponent(String(req.query.added_slug))
    : null;
  const addedUrl = addedSlug
    ? `${process.env.PUBLIC_URL || "https://aira-backend-production-2a71.up.railway.app"}/recorder.html?location=${encodeURIComponent(addedSlug)}`
    : null;
  const flash = req.query.added
    ? `<div class="flash" style="background:#ECFDF5;border-left:3px solid #00AEEF;color:#0A0A0A;">Added <b>${decodeURIComponent(String(req.query.added))}</b> ✓${addedUrl ? `<div style="margin-top:6px;font-size:12px;font-weight:500;">Tablet URL: <code style="font-size:11px;background:#fff;border:1px solid #BAE6FD;border-radius:4px;padding:2px 6px;color:#0284C7;">${addedUrl}</code></div>` : ""}</div>`
    : "";
  const flashDel = req.query.deleted
    ? `<div class="flash" style="background:#FEF3F2;border-left:3px solid #DC2626;color:#0A0A0A;">Deleted ${decodeURIComponent(String(req.query.deleted))} ✓</div>`
    : "";
  const flashErr = req.query.err
    ? `<div class="flash" style="background:#FEF3F2;border-left:3px solid #DC2626;color:#0A0A0A;">${decodeURIComponent(String(req.query.err))}</div>`
    : "";

  const baseUrl =
    process.env.PUBLIC_URL ||
    "https://aira-backend-production-2a71.up.railway.app";
  const recorderUrlFor = (location_id) =>
    `${baseUrl}/recorder.html?location=${encodeURIComponent(location_id)}`;

  const rows = allLocs
    .map((l) => {
      const isCustom = !!l._custom;
      const url = recorderUrlFor(l.location_id);
      return `<tr>
      <td><div style="font-weight:700;color:#111827;">${l.franchise_name}</div><div style="font-size:11px;color:#6B7280;">${l.location_id}</div></td>
      <td style="font-size:13px;color:#374151;">${l.franchisee_email || '<span style="color:#D1D5DB;">—</span>'}${l.vp_email ? `<div style="font-size:11px;color:#9CA3AF;margin-top:2px;">VP: ${l.vp_email}</div>` : ""}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <code style="flex:1;font-size:11px;background:#F3F4F6;border:1px solid #E5E7EB;border-radius:4px;padding:6px 8px;color:#0284C7;font-family:ui-monospace,Menlo,Monaco,monospace;word-break:break-all;line-height:1.4;">${url}</code>
          <button type="button" onclick="copyUrl(this, '${url.replace(/'/g, "\\'")}')" style="flex-shrink:0;padding:6px 10px;background:#0A0A0A;color:#fff;border:0;border-radius:4px;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;font-family:inherit;">Copy</button>
        </div>
      </td>
      <td>${isCustom ? '<span style="display:inline-block;padding:2px 8px;background:#E0F4FB;color:#0284C7;border-radius:9999px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;">Custom</span>' : '<span style="display:inline-block;padding:2px 8px;background:#F3F4F6;color:#6B7280;border-radius:9999px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;">Built-in</span>'}</td>
      <td style="text-align:right;">${isCustom ? `<form method="POST" action="/admin/locations/delete/${encodeURIComponent(l.location_id)}" style="display:inline;" onsubmit="return confirm('Delete ${l.franchise_name}?');"><button type="submit" style="background:transparent;border:0;color:#DC2626;font-weight:700;font-size:12px;cursor:pointer;">Delete</button></form>` : '<span style="color:#D1D5DB;font-size:11px;">in code</span>'}</td>
    </tr>`;
    })
    .join("");

  res.send(`<!DOCTYPE html><html><head><title>Aira Admin · Locations</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:#EEF1F4;color:#111827;-webkit-font-smoothing:antialiased;}
a{color:#0284C7;}
.brand{background:#0A0A0A;padding:22px 28px;text-align:center;}
.brand-mark{font-size:22px;font-weight:900;letter-spacing:.18em;line-height:1;}
.brand-mark .b{color:#00AEEF;} .brand-mark .w{color:#fff;}
.subhead{background:#fff;border-bottom:3px solid #00AEEF;padding:24px 28px;}
.subhead-inner{max-width:1100px;margin:0 auto;}
.eyebrow{font-size:10px;font-weight:800;color:#00AEEF;letter-spacing:.18em;text-transform:uppercase;margin-bottom:6px;}
.title{font-size:24px;font-weight:900;color:#0A0A0A;letter-spacing:-.01em;}
.subtitle{font-size:13px;color:#6B7280;margin-top:4px;}
.wrap{max-width:1100px;margin:0 auto;padding:24px;}
.back{display:inline-block;color:#6B7280;font-size:12px;text-decoration:none;margin-bottom:16px;font-weight:600;}
.back:hover{color:#0A0A0A;}
.flash{padding:12px 16px;border-radius:6px;margin-bottom:18px;font-size:13px;font-weight:600;}
.card{background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:24px 26px;margin-bottom:22px;}
.card h2{font-size:16px;font-weight:900;color:#0A0A0A;margin-bottom:6px;}
.card .lead{font-size:13px;color:#6B7280;margin-bottom:18px;line-height:1.55;}
.fld-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;}
@media(max-width:700px){.fld-grid{grid-template-columns:1fr;}}
.fld{display:block;}
.fld span{display:block;font-size:10px;font-weight:800;color:#6B7280;text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px;}
.fld input{width:100%;padding:10px 12px;border:1px solid #D1D5DB;border-radius:6px;font-size:14px;font-family:inherit;background:#fff;color:#111827;}
.fld input:focus{outline:none;border-color:#00AEEF;}
.fld .hint{font-size:11px;color:#9CA3AF;margin-top:4px;font-weight:500;}
.required{color:#DC2626;}
button.cta{padding:12px 22px;background:#0A0A0A;color:#fff;border:0;border-radius:6px;font-size:13px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;font-family:inherit;}
button.cta:hover{background:#1F2937;}
table{width:100%;border-collapse:collapse;}
thead th{background:#F9FAFB;padding:12px 14px;text-align:left;font-size:10px;color:#6B7280;font-weight:800;text-transform:uppercase;letter-spacing:.12em;border-bottom:1px solid #E5E7EB;}
tbody td{padding:14px;border-bottom:1px solid #F3F4F6;vertical-align:middle;}
tbody tr:last-child td{border-bottom:none;}
tbody tr:hover{background:#F9FAFB;}
.section-eyebrow{font-size:10px;font-weight:800;color:#6B7280;text-transform:uppercase;letter-spacing:.14em;margin:8px 0 10px 4px;}
</style></head><body>

<div class="brand"><div class="brand-mark"><span class="b">AIRA</span>&nbsp;<span class="w">FITNESS</span></div></div>
<div class="subhead"><div class="subhead-inner">
  <div class="eyebrow">Consult Recorder</div>
  <div class="title">Locations</div>
  <div class="subtitle">Add a new gym below. It'll show up everywhere — scorecards, dashboard, practice bot, the closing game — within seconds. No restart needed.</div>
</div></div>

<div class="wrap">
  <a href="/admin" class="back">← Back to Admin</a>

  ${flash}${flashDel}${flashErr}

  <div class="card">
    <h2>Add a new gym</h2>
    <p class="lead">All scorecard emails will go to the franchisee email. Add a VP email to copy a regional director on every consult. Only the first three fields are required.</p>
    <form method="POST" action="/admin/locations">
      <div class="fld-grid">
        <label class="fld"><span>Location ID <span class="required">*</span></span><input name="location_id" required placeholder="naples-01" pattern="[a-z0-9\\-]+" /><div class="hint">Lowercase letters, numbers, and hyphens. Like <code>naples-01</code> or <code>round-rock-02</code>.</div></label>
        <label class="fld"><span>Franchise Name <span class="required">*</span></span><input name="franchise_name" required placeholder="Aira Fitness Naples" /><div class="hint">Display name on emails and the dashboard.</div></label>
      </div>
      <div class="fld-grid">
        <label class="fld"><span>Franchisee Name</span><input name="franchisee_name" placeholder="Jane Smith" /><div class="hint">Shown in the email greeting. Leave blank for "<i>Aira Fitness Naples Team,</i>"</div></label>
        <label class="fld"><span>Franchisee Email <span class="required">*</span></span><input name="franchisee_email" type="email" required placeholder="naples@airafitness.com" /><div class="hint">Primary recipient of every scorecard email.</div></label>
      </div>
      <div class="fld-grid">
        <label class="fld"><span>VP Email</span><input name="vp_email" type="email" placeholder="vp@airafitness.com" /><div class="hint">Optional. Gets cc'd on scorecards from this gym.</div></label>
        <label class="fld"><span>Club Email</span><input name="club_email" type="email" placeholder="" /><div class="hint">Optional. Additional copy.</div></label>
      </div>
      <div class="fld-grid">
        <label class="fld"><span>GHL Calendar ID</span><input name="ghl_calendar_id" placeholder="" /><div class="hint">Optional. Used by the GHL webhook (currently disabled — leave blank if unsure).</div></label>
        <div></div>
      </div>
      <button type="submit" class="cta">Add Gym</button>
    </form>
  </div>

  <div class="card" style="background:#F0FBFF;border:1px solid #BAE6FD;">
    <h2 style="font-size:14px;color:#0284C7;">How to set up a tablet</h2>
    <p class="lead" style="margin-bottom:0;">Each gym has its own unique recorder URL — that's what the tablet at the front desk should be set to. Open the URL in the tablet's browser, allow microphone access, then save it as a home-screen shortcut. The location_id is baked into the URL so every recording from that tablet is automatically tagged to the right gym. Click <b>Copy</b> next to any URL below to grab it.</p>
  </div>

  <div class="section-eyebrow">All Gyms (${allLocs.length})</div>
  <div class="card" style="padding:0;overflow:hidden;">
    <table>
      <thead><tr>
        <th>Gym</th>
        <th>Email Recipients</th>
        <th>Tablet / Recorder URL</th>
        <th>Type</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</div>
<script>
function copyUrl(btn, url) {
  navigator.clipboard.writeText(url).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.style.background = '#00AEEF';
    setTimeout(() => { btn.textContent = original; btn.style.background = '#0A0A0A'; }, 1400);
  }).catch(() => {
    // fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = url; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1400); } catch (e) { alert('Copy failed: ' + url); }
    document.body.removeChild(ta);
  });
}
</script>
</body></html>`);
});

app.post(
  "/admin/locations",
  adminAuth,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const slug = String(req.body.location_id || "")
        .trim()
        .toLowerCase();
      const franchise_name = String(req.body.franchise_name || "").trim();
      const franchisee_email = String(req.body.franchisee_email || "").trim();
      if (!/^[a-z0-9\-]+$/.test(slug)) {
        return res.redirect(
          "/admin/locations?err=" +
            encodeURIComponent(
              "Location ID must be lowercase letters, numbers, hyphens only",
            ),
        );
      }
      if (!franchise_name)
        return res.redirect(
          "/admin/locations?err=" +
            encodeURIComponent("Franchise name is required"),
        );
      if (!franchisee_email)
        return res.redirect(
          "/admin/locations?err=" +
            encodeURIComponent("Franchisee email is required"),
        );
      if (byLocationId[slug] && !byLocationId[slug]._custom) {
        return res.redirect(
          "/admin/locations?err=" +
            encodeURIComponent(
              `'${slug}' is already a built-in location — pick a different ID`,
            ),
        );
      }
      const loc = {
        location_id: slug,
        franchise_name,
        franchisee_name: String(req.body.franchisee_name || "").trim(),
        franchisee_email,
        vp_email: String(req.body.vp_email || "").trim(),
        club_email: String(req.body.club_email || "").trim(),
        ghl_calendar_id: String(req.body.ghl_calendar_id || "").trim(),
      };
      await db.addCustomLocation(loc);
      // refresh in-memory map
      removeCustomLocationFromCache(slug);
      await loadCustomLocations();
      res.redirect(
        "/admin/locations?added=" +
          encodeURIComponent(franchise_name) +
          "&added_slug=" +
          encodeURIComponent(slug),
      );
    } catch (err) {
      console.error("[Admin/locations] add error:", err.message);
      res.redirect("/admin/locations?err=" + encodeURIComponent(err.message));
    }
  },
);

app.post("/admin/locations/delete/:id", adminAuth, async (req, res) => {
  try {
    const slug = String(req.params.id).toLowerCase();
    const existing = byLocationId[slug];
    if (!existing || !existing._custom) {
      return res.redirect(
        "/admin/locations?err=" +
          encodeURIComponent(
            "Can't delete built-in locations (those are in code)",
          ),
      );
    }
    const name = existing.franchise_name;
    await db.deleteCustomLocation(slug);
    removeCustomLocationFromCache(slug);
    res.redirect("/admin/locations?deleted=" + encodeURIComponent(name));
  } catch (err) {
    console.error("[Admin/locations] delete error:", err.message);
    res.redirect("/admin/locations?err=" + encodeURIComponent(err.message));
  }
});

// ─────────── /admin/location/:id — per-gym detail dashboard ───────────

app.get("/admin/location/:id", adminAuth, async (req, res) => {
  try {
    const slug = canonicalLocationId(req.params.id);
    const loc = byLocationId[slug] || {
      location_id: slug,
      franchise_name: slug,
    };

    const allRecordings = await db.getAllRecordings();
    const allScorecards = await db.getAllScorecards();

    // Filter to this location (canonicalize each recording to merge historical aliases).
    const recordingsAll = allRecordings.filter(
      (r) => canonicalLocationId(r.location_id) === slug,
    );
    const recordingIds = new Set(recordingsAll.map((r) => r.recording_id));
    const scorecards = allScorecards.filter((sc) =>
      recordingIds.has(sc.recording_id),
    );

    // Latest scorecard per recording (rescores never delete; analytics use latest only).
    const latestByRec = new Map();
    for (const sc of scorecards) {
      const prev = latestByRec.get(sc.recording_id);
      if (!prev || new Date(sc.created_at) > new Date(prev.created_at))
        latestByRec.set(sc.recording_id, sc);
    }
    const allScored = Array.from(latestByRec.values());
    const historicalScorecardCount = scorecards.length;

    // Date-range filter
    const period = parseRange(req);
    const recDateById = new Map(
      recordingsAll.map((r) => [r.recording_id, r.recorded_at]),
    );
    const recordings = recordingsAll.filter((r) =>
      period.inRange(r.recorded_at),
    );
    const recordingsPrev = recordingsAll.filter((r) =>
      period.inPrev(r.recorded_at),
    );
    const scored = allScored.filter((sc) => {
      const d = recDateById.get(sc.recording_id);
      return d ? period.inRange(d) : true;
    });
    const scoredPrev = allScored.filter((sc) => {
      const d = recDateById.get(sc.recording_id);
      return d ? period.inPrev(d) : false;
    });

    const totalCloses = scored.filter((s) => s.did_close === true).length;
    const closeRate = scored.length
      ? Math.round((totalCloses / scored.length) * 100)
      : 0;
    const avgTotal = scored.length
      ? Math.round(
          scored.reduce((a, s) => a + (s.total_score || 0), 0) / scored.length,
        )
      : 0;
    const prevTotalCloses = scoredPrev.filter(
      (s) => s.did_close === true,
    ).length;
    const prevCloseRate = scoredPrev.length
      ? Math.round((prevTotalCloses / scoredPrev.length) * 100)
      : null;
    const prevAvgTotal = scoredPrev.length
      ? Math.round(
          scoredPrev.reduce((a, s) => a + (s.total_score || 0), 0) /
            scoredPrev.length,
        )
      : null;
    const showDeltas = period.range !== "all" && period.prevLabel;

    const avgCat = (key) =>
      scored.length
        ? Math.round(
            (scored.reduce((a, s) => a + (s[key] || 0), 0) / scored.length) *
              10,
          ) / 10
        : 0;
    const catStats = [
      { label: "Sit-Down", avg: avgCat("sitdown_score") },
      { label: "Objection Handling", avg: avgCat("objection_score") },
      { label: "Language & Psychology", avg: avgCat("language_score") },
      { label: "Close Execution", avg: avgCat("close_score") },
    ].sort((a, b) => a.avg - b.avg);

    // 30-day daily series for this gym
    const recById = new Map(recordings.map((r) => [r.recording_id, r]));
    const todayMs = Date.now();
    const DAY_MS = 86400000;
    const dailyScores = Array.from({ length: 30 }, () => []);
    const dailyClosed = Array.from({ length: 30 }, () => 0);
    const dailyTotal = Array.from({ length: 30 }, () => 0);
    for (const sc of scored) {
      const rec = recById.get(sc.recording_id);
      if (!rec) continue;
      const ageDays = Math.floor(
        (todayMs - new Date(rec.recorded_at).getTime()) / DAY_MS,
      );
      if (ageDays < 0 || ageDays >= 30) continue;
      const idx = 29 - ageDays;
      dailyScores[idx].push(sc.total_score || 0);
      dailyTotal[idx] += 1;
      if (sc.did_close === true) dailyClosed[idx] += 1;
    }
    const sparkScore = dailyScores.map((arr) =>
      arr.length
        ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
        : null,
    );
    const sparkClose = dailyTotal.map((t, i) =>
      t ? Math.round((dailyClosed[i] / t) * 100) : null,
    );
    function sparklineSvg(series, color, width = 130, height = 32) {
      const pts = series.map((v, i) => ({ v, i }));
      const valid = pts.filter((p) => p.v !== null);
      if (valid.length === 0) return "";
      const min = Math.min(...valid.map((p) => p.v));
      const max = Math.max(...valid.map((p) => p.v));
      const range = max - min || 1;
      const xStep = width / (series.length - 1);
      const y = (v) => height - 4 - ((v - min) / range) * (height - 8);
      const path = valid
        .map(
          (p, i) =>
            `${i === 0 ? "M" : "L"} ${(p.i * xStep).toFixed(1)} ${y(p.v).toFixed(1)}`,
        )
        .join(" ");
      const lastPt = valid[valid.length - 1];
      return `<svg width="${width}" height="${height}" style="display:block;margin-top:6px;overflow:visible;" viewBox="0 0 ${width} ${height}"><path d="${path}" stroke="${color}" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" /><circle cx="${(lastPt.i * xStep).toFixed(1)}" cy="${y(lastPt.v).toFixed(1)}" r="2.5" fill="${color}" /></svg>`;
    }

    // Recurring themes specific to this gym (same patterns as /admin, scoped to this location's scorecards)
    const themes = [
      {
        name: "Skipped 'Make sense?' close on sit-down",
        patterns: [
          /make sense\??\s*(close|check|micro)/i,
          /skipped (the )?['"]?make sense/i,
          /missed (the )?['"]?make sense/i,
          /didn'?t (say|use|land) ['"]?make sense/i,
        ],
      },
      {
        name: "Offered discount before isolating cost (skipped Deaf Ear)",
        patterns: [
          /(coupon|discount).{0,40}(too early|before.{0,30}(deaf ear|isolat))/i,
          /skipped (the )?deaf ear/i,
          /didn'?t run (the )?deaf ear/i,
          /led with (the )?(coupon|discount)/i,
          /jump(ed|ing) to (the )?coupon/i,
        ],
      },
      {
        name: "Permission-seeking instead of assumptive close",
        patterns: [/permission.?seeking/i, /not assumptive/i],
      },
      {
        name: "Accepted 'let me think about it' without re-closing",
        patterns: [
          /accept(ed|ing) ['"]?(let me think|I'?ll come back|I need to think)/i,
          /didn'?t re-?close/i,
          /let (her|him|them) walk/i,
          /didn'?t push back/i,
        ],
      },
      {
        name: "Didn't run tie-downs after buying signals",
        patterns: [
          /skipped (the )?tie.?down/i,
          /missed (the )?tie.?down/i,
          /didn'?t run (the )?tie.?down/i,
          /no tie.?down/i,
        ],
      },
      {
        name: "Didn't offer PIF after close",
        patterns: [
          /didn'?t (offer|run) (the )?pif/i,
          /skipped (the )?pif/i,
          /missed (the )?pif/i,
          /no pif (close|offer)/i,
        ],
      },
      {
        name: "Didn't collect referrals",
        patterns: [
          /didn'?t (collect|ask for|run) referrals?/i,
          /skipped (the )?referral/i,
          /missed (the )?referral/i,
          /no referral collect/i,
        ],
      },
      {
        name: "Closed (or attempted to) while standing",
        patterns: [
          /clos(ed|ing) (while )?standing/i,
          /didn'?t sit down/i,
          /never sat down/i,
          /standing close/i,
        ],
      },
      {
        name: "Used Google Review Drop too early",
        patterns: [
          /google review.{0,30}(too early|before.{0,30}(coupon|deaf ear))/i,
          /jump(ed|ing) to (the )?google review/i,
          /led with (the )?google review/i,
        ],
      },
      {
        name: "Didn't present all 3 tiers",
        patterns: [
          /didn'?t (present|show) all (3|three) tiers/i,
          /skipped (a )?tier/i,
          /only (presented|showed) (one|two)/i,
        ],
      },
      {
        name: "Skipped 'By The Way' close on free pass",
        patterns: [
          /skipped (the )?by the way/i,
          /missed (the )?by the way/i,
          /didn'?t use (the )?by the way/i,
        ],
      },
    ];
    const themeCounts = themes
      .map((t) => {
        let count = 0;
        for (const sc of scored) {
          const hay = [
            sc.overall_coaching,
            sc.coaching_note,
            sc.process_warning,
            sc.sitdown_score_explainer,
            sc.objection_score_explainer,
            sc.language_score_explainer,
            sc.close_score_explainer,
            sc.sitdown_coaching,
            sc.objection_coaching,
            sc.language_coaching,
            sc.close_coaching,
          ]
            .filter(Boolean)
            .join(" ");
          if (t.patterns.some((p) => p.test(hay))) count++;
        }
        const pct = scored.length
          ? Math.round((count / scored.length) * 100)
          : 0;
        return { name: t.name, count, pct };
      })
      .filter((t) => t.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    const fmtDate = (d) =>
      new Date(d).toLocaleString("en-US", {
        timeZone: "America/Chicago",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    const fmtDuration = (sec) => Math.round(sec / 60) + "m " + (sec % 60) + "s";
    const scorePill = (sc) => {
      if (!sc) return '<span style="color:#9CA3AF;font-size:12px;">—</span>';
      const score = sc.total_score;
      const color =
        score >= 70 ? "#00AEEF" : score >= 50 ? "#0284C7" : "#DC2626";
      return `<a href="/scorecard/${sc.recording_id}" target="_blank" style="display:inline-block;padding:4px 10px;background:#fff;border:1.5px solid ${color};color:${color};border-radius:9999px;font-size:12px;font-weight:800;text-decoration:none;letter-spacing:.02em;">${score}<span style="color:#9CA3AF;font-weight:600;"> / 100</span></a>`;
    };
    const statusPill = (status) => {
      const s = status || "pending";
      let bg = "#F3F4F6",
        color = "#6B7280",
        border = "#E5E7EB";
      if (s === "transcribing" || s === "scoring" || s === "transcribed") {
        bg = "#E0F4FB";
        color = "#0284C7";
        border = "#BAE6FD";
      } else if (s === "scored") {
        bg = "#0A0A0A";
        color = "#fff";
        border = "#0A0A0A";
      } else if (s === "failed") {
        bg = "#FEE2E2";
        color = "#DC2626";
        border = "#FECACA";
      }
      return `<span style="display:inline-block;padding:3px 10px;background:${bg};color:${color};border:1px solid ${border};border-radius:9999px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">${s}</span>`;
    };

    const recordingRows = recordings
      .sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at))
      .map((r) => {
        const sc = latestByRec.get(r.recording_id);
        const name = r.contact_name || r.appointment_id;
        return `<tr>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#6B7280;white-space:nowrap;">${fmtDate(r.recorded_at)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#374151;">${name}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#6B7280;white-space:nowrap;">${fmtDuration(r.duration_seconds)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;">${statusPill(r.processing_status)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;">${scorePill(sc)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;">${r.audio_file_url ? `<a href="/playback/${r.recording_id}" style="color:#0284C7;text-decoration:none;font-weight:600;">▶ Play</a>` : '<span style="color:#D1D5DB;">—</span>'}</td>
      </tr>`;
      })
      .join("");

    const baseUrl =
      process.env.PUBLIC_URL ||
      "https://aira-backend-production-2a71.up.railway.app";
    const recorderUrl = `${baseUrl}/recorder.html?location=${encodeURIComponent(slug)}`;

    res.send(`<!DOCTYPE html><html><head><title>${loc.franchise_name} — Aira Admin</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:#EEF1F4;color:#111827;-webkit-font-smoothing:antialiased;}
a{color:#0284C7;}
.brand{background:#0A0A0A;padding:22px 28px;text-align:center;}
.brand-mark{font-size:22px;font-weight:900;letter-spacing:.18em;line-height:1;}
.brand-mark .b{color:#00AEEF;} .brand-mark .w{color:#fff;}
.subhead{background:#fff;border-bottom:3px solid #00AEEF;padding:24px 28px;}
.subhead-inner{max-width:1200px;margin:0 auto;}
.eyebrow{font-size:10px;font-weight:800;color:#00AEEF;letter-spacing:.18em;text-transform:uppercase;margin-bottom:6px;}
.title{font-size:24px;font-weight:900;color:#0A0A0A;letter-spacing:-.01em;}
.subtitle{font-size:13px;color:#6B7280;margin-top:4px;}
.wrap{max-width:1200px;margin:0 auto;padding:0 24px 48px;}
.back{display:inline-block;color:#6B7280;font-size:12px;text-decoration:none;font-weight:600;margin:18px 0;}
.back:hover{color:#0A0A0A;}
.card{background:#fff;border:1px solid #E5E7EB;border-radius:10px;}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:20px;}
.kpi{padding:16px 18px;}
.kpi-label{font-size:10px;font-weight:800;color:#6B7280;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;}
.kpi-num{font-size:30px;font-weight:900;color:#00AEEF;line-height:1.1;letter-spacing:-.02em;}
.kpi-foot{font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.1em;margin-top:6px;}
.kpi-delta{font-size:11px;font-weight:800;letter-spacing:.04em;margin-top:8px;display:inline-block;padding:2px 8px;border-radius:9999px;}
.kpi-delta.good{background:#ECFDF5;color:#15803d;}
.kpi-delta.bad{background:#FEF3F2;color:#DC2626;}
.kpi-delta.neutral{background:#F3F4F6;color:#6B7280;}
.range-bar{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 14px;}
.range-pill{display:inline-block;padding:7px 14px;background:#fff;border:1px solid #E5E7EB;color:#374151;border-radius:9999px;font-size:12px;font-weight:700;text-decoration:none;letter-spacing:.02em;transition:all .15s;}
.range-pill:hover{border-color:#0284C7;color:#0284C7;}
.range-pill.active{background:#0A0A0A;color:#fff;border-color:#0A0A0A;}
.period-banner{font-size:12px;color:#6B7280;margin-bottom:18px;padding:0 4px;}
.period-banner b{color:#0A0A0A;font-weight:800;}
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
.info-row{display:grid;grid-template-columns:1fr 2fr;gap:8px 18px;padding:14px 22px;font-size:13px;}
.info-row dt{font-size:10px;color:#6B7280;font-weight:800;text-transform:uppercase;letter-spacing:.1em;align-self:center;}
.info-row dd{color:#111827;font-weight:600;word-break:break-all;}
.info-row code{font-family:ui-monospace,Menlo,Monaco,monospace;background:#F3F4F6;border:1px solid #E5E7EB;border-radius:4px;padding:3px 6px;font-size:12px;color:#0284C7;}
.empty{text-align:center;color:#9CA3AF;padding:40px;font-size:13px;}
table{width:100%;border-collapse:collapse;}
thead th{background:#F9FAFB;padding:12px 16px;text-align:left;font-size:10px;color:#6B7280;font-weight:800;text-transform:uppercase;letter-spacing:.12em;border-bottom:1px solid #E5E7EB;}
tbody tr:last-child td{border-bottom:none;}
tbody tr:hover{background:#F9FAFB;}
</style></head><body>

<div class="brand"><div class="brand-mark"><span class="b">AIRA</span>&nbsp;<span class="w">FITNESS</span></div></div>
<div class="subhead"><div class="subhead-inner">
  <div class="eyebrow">Location Detail</div>
  <div class="title">${loc.franchise_name}</div>
  <div class="subtitle">${slug} &nbsp;·&nbsp; ${recordings.length} recording${recordings.length === 1 ? "" : "s"} &nbsp;·&nbsp; ${scored.length} scored ${historicalScorecardCount > scored.length ? `(<span title="rescores never delete — historical rows preserved">${historicalScorecardCount} total in history</span>)` : ""}</div>
</div></div>

<div class="wrap">
  <a href="/admin" class="back">← Back to all locations</a>

  ${rangeSelectorHtml(period.range, `/admin/location/${encodeURIComponent(slug)}`)}
  <div class="period-banner">Showing: <b>${period.label}</b>${showDeltas ? ` &nbsp;·&nbsp; <span style="color:#9CA3AF;">comparing ${period.prevLabel}</span>` : ""}</div>

  <div class="kpi-grid">
    <div class="card kpi"><div class="kpi-label">Recordings</div><div class="kpi-num">${recordings.length}</div>${showDeltas ? deltaHtml(recordings.length, recordingsPrev.length) : ""}</div>
    <div class="card kpi"><div class="kpi-label">Scored</div><div class="kpi-num">${scored.length}</div>${showDeltas ? deltaHtml(scored.length, scoredPrev.length) : ""}</div>
    <div class="card kpi"><div class="kpi-label">Total Closes</div><div class="kpi-num">${totalCloses}</div>${showDeltas ? deltaHtml(totalCloses, prevTotalCloses) : ""}</div>
    <div class="card kpi">
      <div class="kpi-label">Close Rate</div>
      <div class="kpi-num" style="color:${closeRate >= 30 ? "#00AEEF" : closeRate >= 15 ? "#0284C7" : "#DC2626"};">${closeRate}<span style="font-size:18px;color:#9CA3AF;font-weight:600;">%</span></div>
      ${showDeltas ? deltaHtml(closeRate, prevCloseRate, "%") : sparklineSvg(sparkClose, closeRate >= 30 ? "#00AEEF" : closeRate >= 15 ? "#0284C7" : "#DC2626") + '<div class="kpi-foot">last 30 days</div>'}
    </div>
    <div class="card kpi">
      <div class="kpi-label">Avg Score</div>
      <div class="kpi-num" style="color:${avgTotal >= 70 ? "#00AEEF" : avgTotal >= 50 ? "#0284C7" : "#DC2626"};">${avgTotal}<span style="font-size:18px;color:#9CA3AF;font-weight:600;"> / 100</span></div>
      ${showDeltas ? deltaHtml(avgTotal, prevAvgTotal) : sparklineSvg(sparkScore, avgTotal >= 70 ? "#00AEEF" : avgTotal >= 50 ? "#0284C7" : "#DC2626") + '<div class="kpi-foot">last 30 days</div>'}
    </div>
  </div>

  <div class="insights">
    <div class="card panel">
      <div class="panel-header">
        <div class="panel-eyebrow">Average Score by Category</div>
        <div class="panel-sub">${scored.length} scored consult${scored.length === 1 ? "" : "s"} — weakest first</div>
      </div>
      ${
        scored.length === 0
          ? '<div class="panel-empty">No scored consults yet for this gym.</div>'
          : catStats
              .map((c) => {
                const pct = (c.avg / 25) * 100;
                const color =
                  pct >= 80 ? "#00AEEF" : pct >= 60 ? "#0284C7" : "#DC2626";
                return `<div class="cat-row"><div class="cat-row-head"><div class="cat-label">${c.label}</div><div class="cat-score" style="color:${color};">${c.avg}<span style="color:#9CA3AF;font-weight:600;"> / 25</span></div></div><div class="cat-bar"><div class="cat-bar-fill" style="background:${color};width:${pct}%;"></div></div></div>`;
              })
              .join("")
      }
    </div>

    <div class="card panel">
      <div class="panel-header">
        <div class="panel-eyebrow">Top Coaching Themes</div>
        <div class="panel-sub">Recurring mistakes at this gym — train these first</div>
      </div>
      ${
        themeCounts.length === 0
          ? '<div class="panel-empty">No recurring themes detected yet at this gym.</div>'
          : themeCounts
              .map((t, i) => {
                const sev =
                  t.pct >= 50 ? "#DC2626" : t.pct >= 25 ? "#0284C7" : "#00AEEF";
                return `<div class="theme-row"><div class="theme-rank" style="color:${sev};">${i + 1}</div><div class="theme-body"><div class="theme-name">${t.name}</div><div class="theme-bar"><div class="theme-bar-fill" style="background:${sev};width:${t.pct}%;"></div></div></div><div class="theme-count" style="color:${sev};">${t.count}<span style="color:#9CA3AF;font-weight:600;font-size:11px;"> / ${scored.length}</span></div></div>`;
              })
              .join("")
      }
    </div>
  </div>

  <div class="section-eyebrow">Gym Info</div>
  <div class="card" style="margin-bottom:20px;">
    <dl class="info-row">
      <dt>Franchisee</dt><dd>${loc.franchisee_name || '<span style="color:#D1D5DB;">—</span>'}</dd>
      <dt>Franchisee Email</dt><dd>${loc.franchisee_email || '<span style="color:#D1D5DB;">—</span>'}</dd>
      ${loc.vp_email ? `<dt>VP Email</dt><dd>${loc.vp_email}</dd>` : ""}
      <dt>Tablet URL</dt><dd><code>${recorderUrl}</code></dd>
    </dl>
  </div>

  <div class="section-eyebrow">All Recordings (${recordings.length})</div>
  <div class="card" style="overflow:hidden;">
    <table>
      <thead><tr>
        <th>Date</th><th>Prospect</th><th>Duration</th><th>Status</th><th>Score</th><th>Audio</th>
      </tr></thead>
      <tbody>
        ${recordingRows || '<tr><td colspan="6" class="empty">No recordings yet from this gym.</td></tr>'}
      </tbody>
    </table>
  </div>
</div>
</body></html>`);
  } catch (err) {
    console.error("[Admin/location] Error:", err.message);
    res.status(500).send("Error loading location: " + err.message);
  }
});

app.get("/admin/library", adminAuth, async (req, res) => {
  try {
    const recordings = await db.getAllRecordings();
    const scorecards = await db.getAllScorecards();
    const latestByRec = new Map();
    for (const sc of scorecards) {
      const prev = latestByRec.get(sc.recording_id);
      if (!prev || new Date(sc.created_at) > new Date(prev.created_at))
        latestByRec.set(sc.recording_id, sc);
    }

    // Prospect objection patterns — what the prospect SAYS, scanned against transcripts.
    const objections = [
      {
        id: "think",
        name: "“I need to think about it”",
        patterns: [
          /\bI(?:'| a)?(?:m|\s+a)?\s*(?:need|want|got)?(?:ta| to)?\s*think (?:about it|on it|it over)\b/i,
          /\blet me think\b/i,
          /\bI(?:'?ll| will) think (?:about|on)\b/i,
        ],
      },
      {
        id: "spouse",
        name: "“I need to talk to my spouse”",
        patterns: [
          /\btalk to my (wife|husband|spouse|partner|boyfriend|girlfriend|man|woman)\b/i,
          /\bask my (wife|husband|spouse|partner)\b/i,
          /\bcheck with my (wife|husband|spouse|partner)\b/i,
        ],
      },
      {
        id: "afford",
        name: "“I can't afford it” / “too expensive”",
        patterns: [
          /\bcan'?t afford\b/i,
          /\b(too|kinda|kind of) (expensive|pricey|much)\b/i,
          /\bout of (my )?budget\b/i,
          /\bdon'?t have the money\b/i,
          /\bmoney('?s)? tight\b/i,
        ],
      },
      {
        id: "trial",
        name: "“Can I try it first?” / free pass",
        patterns: [
          /\btry (it|the gym) (out|first)\b/i,
          /\b(free|day|guest|trial)\s*(pass|day)\b/i,
          /\bcome (back|in) (and )?(try|test)\b/i,
        ],
      },
      {
        id: "later",
        name: "“I'll come back later” / “next week”",
        patterns: [
          /\bcome back (later|tomorrow|on |next|in|after)\b/i,
          /\bI'?ll be back\b/i,
          /\b(later|next) (this )?(week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
          /\b(stop|come) (back|by) (later|tomorrow)\b/i,
        ],
      },
      {
        id: "shopping",
        name: "“I'm just looking around” / shopping other gyms",
        patterns: [
          /\bjust (looking|browsing|checking)\b/i,
          /\b(checking out|shopping|comparing) (a few|other|several|some) (gyms|places)\b/i,
          /\bgoing to (look at|check out) (a )?(few|other|some|another)\b/i,
        ],
      },
      {
        id: "payday",
        name: "“I just got paid / next paycheck” (timing-based)",
        patterns: [
          /\b(don'?t get paid|get paid) (on|till|until|next|on the)\b/i,
          /\bnext (paycheck|pay\s*day|pay period)\b/i,
          /\bpaid (on |the )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|1st|15th|first|fifteenth)\b/i,
          /\bafter pay ?day\b/i,
          /\bbroke (until|till)\b/i,
        ],
      },
    ];

    const stripTags = (s) => (s || "").replace(/<[^>]+>/g, "");
    const excerpt = (transcript, idx, len) => {
      const start = Math.max(0, idx - 140);
      const end = Math.min(transcript.length, idx + len + 280);
      let text = transcript.slice(start, end);
      if (start > 0) text = "… " + text.replace(/^\S*\s/, "");
      if (end < transcript.length) text = text.replace(/\s\S*$/, "") + " …";
      // Highlight the matched phrase
      const matchTxt = transcript.slice(idx, idx + len);
      const safeMatch = matchTxt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return text.replace(
        new RegExp(safeMatch, "i"),
        `<mark style="background:#FEF3C7;padding:0 2px;border-radius:2px;color:#92400E;font-weight:600;">${matchTxt}</mark>`,
      );
    };

    // For each objection, find every match across transcripts and pair with the scorecard.
    const buckets = objections.map((o) => ({ ...o, hits: [] }));
    for (const rec of recordings) {
      if (!rec.transcript) continue;
      const sc = latestByRec.get(rec.recording_id);
      if (!sc) continue;
      const loc = byLocationId[rec.location_id] || {};
      for (const b of buckets) {
        for (const p of b.patterns) {
          const m = rec.transcript.match(p);
          if (m && m.index != null) {
            b.hits.push({
              recording_id: rec.recording_id,
              franchise_name: loc.franchise_name || rec.location_id,
              recorded_at: rec.recorded_at,
              total_score: sc.total_score,
              did_close: sc.did_close === true,
              ai_summary: sc.ai_summary || "",
              excerpt: excerpt(rec.transcript, m.index, m[0].length),
            });
            break; // one hit per recording per bucket
          }
        }
      }
    }

    // For each bucket, pick best closed + worst not-closed pair (or top examples if only one side present).
    const sections = buckets
      .map((b) => {
        const closed = b.hits
          .filter((h) => h.did_close)
          .sort((a, b) => b.total_score - a.total_score)
          .slice(0, 2);
        const notClosed = b.hits
          .filter((h) => !h.did_close)
          .sort((a, b) => a.total_score - b.total_score)
          .slice(0, 2);
        return { ...b, closed, notClosed };
      })
      .filter((s) => s.closed.length + s.notClosed.length > 0);

    const renderCard = (h, isClose) => {
      const accent = isClose ? "#00AEEF" : "#DC2626";
      const label = isClose ? "✓ CLOSED" : "✗ NO SALE";
      const date = new Date(h.recorded_at).toLocaleDateString("en-US", {
        timeZone: "America/Chicago",
        month: "short",
        day: "numeric",
      });
      return `<a href="/scorecard/${h.recording_id}" target="_blank" style="display:block;text-decoration:none;color:inherit;">
        <div class="pair-card" style="border-left:4px solid ${accent};">
          <div class="pair-head">
            <div class="pair-label" style="color:${accent};">${label}</div>
            <div class="pair-meta">${h.franchise_name} · ${date} · <span style="color:${accent};font-weight:800;">${h.total_score}/100</span></div>
          </div>
          <div class="pair-excerpt">${h.excerpt}</div>
          <div class="pair-summary">${stripTags(h.ai_summary)}</div>
          <div class="pair-cta">View full scorecard →</div>
        </div>
      </a>`;
    };

    const html = `<!DOCTYPE html><html><head><title>Aira Library — Best/Worst Pairs</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:#EEF1F4;color:#111827;-webkit-font-smoothing:antialiased;}
a{color:#0284C7;}
.brand{background:#0A0A0A;padding:22px 28px;text-align:center;}
.brand-mark{font-size:22px;font-weight:900;letter-spacing:.18em;line-height:1;}
.brand-mark .b{color:#00AEEF;} .brand-mark .w{color:#fff;}
.subhead{background:#fff;border-bottom:3px solid #00AEEF;padding:24px 28px;}
.subhead-inner{max-width:1100px;margin:0 auto;}
.eyebrow{font-size:10px;font-weight:800;color:#00AEEF;letter-spacing:.18em;text-transform:uppercase;margin-bottom:6px;}
.title{font-size:24px;font-weight:900;color:#0A0A0A;letter-spacing:-.01em;}
.subtitle{font-size:13px;color:#6B7280;margin-top:4px;}
.wrap{max-width:1100px;margin:0 auto;padding:24px;}
.back{display:inline-block;color:#6B7280;font-size:12px;text-decoration:none;margin-bottom:16px;font-weight:600;}
.back:hover{color:#0A0A0A;}
.objection{background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:22px 24px;margin-bottom:20px;}
.objection-head{margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid #F3F4F6;}
.objection-quote{font-size:18px;font-weight:900;color:#0A0A0A;letter-spacing:-.01em;line-height:1.3;}
.objection-meta{font-size:12px;color:#6B7280;margin-top:4px;}
.pair-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
@media(max-width:760px){.pair-grid{grid-template-columns:1fr;}}
.pair-col-label{font-size:10px;font-weight:800;color:#6B7280;text-transform:uppercase;letter-spacing:.14em;margin-bottom:8px;}
.pair-card{background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:16px 18px;margin-bottom:12px;transition:background .15s;}
.pair-card:hover{background:#F3F4F6;}
.pair-head{margin-bottom:10px;}
.pair-label{font-size:10px;font-weight:900;letter-spacing:.14em;}
.pair-meta{font-size:12px;color:#6B7280;margin-top:3px;}
.pair-excerpt{font-size:13px;color:#374151;line-height:1.6;background:#fff;border:1px solid #E5E7EB;border-radius:6px;padding:12px 14px;font-style:italic;}
.pair-summary{font-size:12px;color:#6B7280;line-height:1.5;margin-top:10px;}
.pair-cta{font-size:11px;color:#0284C7;font-weight:700;margin-top:10px;text-transform:uppercase;letter-spacing:.08em;}
.empty{padding:18px;text-align:center;color:#9CA3AF;font-size:13px;font-style:italic;}
.intro{background:#fff;border:1px solid #E5E7EB;border-left:4px solid #00AEEF;border-radius:8px;padding:16px 20px;margin-bottom:24px;font-size:13px;color:#374151;line-height:1.6;}
.intro b{color:#0A0A0A;}
</style></head><body>
<div class="brand"><div class="brand-mark"><span class="b">AIRA</span>&nbsp;<span class="w">FITNESS</span></div></div>
<div class="subhead"><div class="subhead-inner">
  <div class="eyebrow">Training Library</div>
  <div class="title">Best vs Worst — Real Consults</div>
  <div class="subtitle">For each common objection, see one rep who closed it and one who didn't. Pulled from real recordings.</div>
</div></div>
<div class="wrap">
  <a href="/admin" class="back">← Back to Admin</a>
  <div class="intro"><b>How to use:</b> Pick an objection. Read the closed example, read the no-sale example. Notice what changed between them. Click any card to see the full transcript and coaching note.</div>
  ${
    sections.length === 0
      ? '<div class="objection"><div class="empty">Not enough scored recordings yet to build pairs. Library populates as the corpus grows.</div></div>'
      : sections
          .map(
            (s) => `
    <div class="objection">
      <div class="objection-head">
        <div class="objection-quote">${s.name}</div>
        <div class="objection-meta">${s.hits.length} consult${s.hits.length === 1 ? "" : "s"} where this objection came up</div>
      </div>
      <div class="pair-grid">
        <div>
          <div class="pair-col-label" style="color:#00AEEF;">✓ They closed it</div>
          ${s.closed.length === 0 ? '<div class="pair-card empty">No closed example yet for this objection.</div>' : s.closed.map((h) => renderCard(h, true)).join("")}
        </div>
        <div>
          <div class="pair-col-label" style="color:#DC2626;">✗ They lost the sale</div>
          ${s.notClosed.length === 0 ? '<div class="pair-card empty">No no-sale example yet for this objection.</div>' : s.notClosed.map((h) => renderCard(h, false)).join("")}
        </div>
      </div>
    </div>
  `,
          )
          .join("")
  }
</div>
</body></html>`;
    res.send(html);
  } catch (err) {
    console.error("[Library] Error:", err.message);
    res.status(500).send("Error loading library: " + err.message);
  }
});

// ─────────── PRACTICE BOT — v0 ───────────
// Role-play a gym prospect, get scored at the end. No auth, no persistence in v0.
// Location dropdown (from locations.js) is informational so future analytics can be tagged.

app.post("/practice/start", async (req, res) => {
  try {
    const difficulty = String(req.body.difficulty || "medium").toLowerCase();
    if (!PROSPECT_PERSONAS[difficulty])
      return res.status(400).json({ ok: false, error: "Invalid difficulty" });
    const location_id = req.body.location_id
      ? canonicalLocationId(req.body.location_id)
      : null;
    // Recently-seen scenario IDs come from a cookie on this browser. Pass them in so
    // the picker biases away from repeats. The cookie is updated client-side after each session.
    const cookieRaw = req.headers.cookie || "";
    const m = cookieRaw.match(/aira_seen=([^;]+)/);
    const recently_seen = m ? decodeURIComponent(m[1]) : "";
    // Game-mode params (optional). When mode=game, we lock in a specific scenario_id and
    // tag the session with player_id/player_name so progress can be queried later.
    const mode = req.body.mode === "game" ? "game" : "practice";
    const player_id = req.body.player_id || null;
    const player_name = req.body.player_name || null;
    const forced_scenario_id = req.body.scenario_id || null;
    const out = startPracticeSession({
      difficulty,
      location_id,
      recently_seen,
      mode,
      player_id,
      player_name,
      forced_scenario_id,
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error("[Practice] start error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/practice/turn", async (req, res) => {
  try {
    const { session_id, message } = req.body;
    if (!session_id || !message)
      return res
        .status(400)
        .json({ ok: false, error: "session_id and message required" });
    const reply = await chatAsProspect(session_id, message);
    res.json({ ok: true, reply });
  } catch (err) {
    console.error("[Practice] turn error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/practice/end", async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id)
      return res.status(400).json({ ok: false, error: "session_id required" });
    const session = getPracticeSession(session_id);
    if (!session)
      return res
        .status(404)
        .json({ ok: false, error: "Session not found or expired" });
    if (session.messages.length < 4) {
      return res.status(400).json({
        ok: false,
        error: "Conversation too short to score (need at least 2 exchanges)",
      });
    }
    const result = await scorePracticeSession(session_id);

    // Persist BEFORE responding so the corpus is durable even if the client disconnects.
    const location = byLocationId[session.location_id] || {
      location_id: session.location_id || "unknown",
      franchise_name: session.location_id || "Aira Fitness",
    };
    const personaLabelForRecord = `${session.bucket_label} — ${session.scenario.name}`;
    try {
      await db.savePracticeSession({
        session_id,
        location_id: session.location_id || null,
        difficulty: session.difficulty,
        persona_label: personaLabelForRecord,
        scenario_id: session.scenario.id,
        player_id: session.player_id || null,
        player_name: session.player_name || null,
        mode: session.mode || "practice",
        messages: result.messages,
        scorecard: result.scorecard,
      });
    } catch (dbErr) {
      console.error("[Practice] DB save failed:", dbErr.message);
      // don't fail the user-facing response — the scorecard still renders
    }

    res.json({
      ok: true,
      scorecard: result.scorecard,
      messages: result.messages,
      scenario_id: session.scenario.id,
    });

    // Fire-and-forget email — don't block the response.
    sendPracticeEmail({
      session_id,
      location,
      difficulty: session.difficulty,
      persona_label: personaLabelForRecord,
      messages: result.messages,
      scorecard: result.scorecard,
    }).catch((emailErr) => {
      console.error("[Practice] email failed:", emailErr.message);
    });
  } catch (err) {
    console.error("[Practice] end error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────── AIRA FITNESS CLOSING GAME ───────────

// Identify a player by email. Returns the canonical player_id. If a cookie player_id
// is supplied AND it has prior sessions, those sessions get claimed for this email.
app.post(
  "/airafitnessclosinggame/identify",
  express.json(),
  async (req, res) => {
    try {
      const email = String(req.body.email || "").trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res
          .status(400)
          .json({ ok: false, error: "Valid email required" });
      }
      const name = String(req.body.name || "").trim();
      const location_id = req.body.location_id
        ? canonicalLocationId(req.body.location_id)
        : null;
      const claim_player_id = req.body.claim_player_id
        ? String(req.body.claim_player_id)
        : null;
      const player = await db.findOrCreatePlayer({
        email,
        name,
        location_id,
        claim_player_id,
      });
      res.json({
        ok: true,
        player_id: player.player_id,
        email: player.email,
        display_name: player.display_name,
        location_id: player.location_id,
        claimed: !!player.claimed,
      });
    } catch (err) {
      console.error("[Game] identify error:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  },
);

app.get("/airafitnessclosinggame/progress", async (req, res) => {
  try {
    const player_id = req.query.player_id;
    if (!player_id)
      return res.status(400).json({ ok: false, error: "player_id required" });
    const progress = await db.getPlayerGameProgress(player_id);
    res.json({ ok: true, progress, levels: GAME_LEVELS });
  } catch (err) {
    console.error("[Game] progress error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/airafitnessclosinggame/leaderboard", async (req, res) => {
  try {
    const board = await db.getGameLeaderboard(25);
    res.json({ ok: true, leaderboard: board });
  } catch (err) {
    console.error("[Game] leaderboard error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/airafitnessclosinggame/scenario/:id", (req, res) => {
  const sc = findScenarioById(req.params.id);
  if (!sc)
    return res.status(404).json({ ok: false, error: "Scenario not found" });
  res.json({
    ok: true,
    scenario: {
      id: sc.id,
      name: sc.name,
      difficulty: sc.difficulty,
      level: sc.level,
      opening_preview: sc.opening,
    },
  });
});

app.get("/airafitnessclosinggame", (req, res) => {
  const locOptions = ALL_LOCATIONS.map(
    (l) => `<option value="${l.location_id}">${l.franchise_name}</option>`,
  ).join("");
  // Send the full level + scenario metadata so the client can render the level map.
  const levelData = GAME_LEVELS.map((lvl) => ({
    level: lvl.level,
    name: lvl.name,
    title: lvl.title,
    description: lvl.description,
    color: lvl.color,
    scenarios: lvl.scenarios
      .map((sid) => {
        const sc = findScenarioById(sid);
        return sc
          ? {
              id: sc.id,
              name: sc.name,
              difficulty: sc.difficulty,
              opening: sc.opening,
            }
          : null;
      })
      .filter(Boolean),
  }));

  res.send(`<!DOCTYPE html><html><head><title>Aira Fitness Closing Game</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%;}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Arial,sans-serif;
  background:#05080F;
  color:#E5E7EB;
  -webkit-font-smoothing:antialiased;
  overflow-x:hidden;
  position:relative;
  min-height:100vh;
}
/* Animated aurora background */
body::before{
  content:'';
  position:fixed;
  inset:-50%;
  background:
    radial-gradient(ellipse 60% 40% at 20% 20%, rgba(0,174,239,0.20), transparent 60%),
    radial-gradient(ellipse 50% 50% at 80% 30%, rgba(124,58,237,0.16), transparent 60%),
    radial-gradient(ellipse 70% 50% at 50% 90%, rgba(236,72,153,0.12), transparent 60%);
  filter:blur(40px);
  z-index:0;
  animation:auroraShift 20s ease-in-out infinite alternate;
}
@keyframes auroraShift{
  0%{transform:translate(0,0) rotate(0);}
  100%{transform:translate(-3%,3%) rotate(2deg);}
}
body::after{
  content:'';
  position:fixed;
  inset:0;
  background-image:
    radial-gradient(1px 1px at 12% 18%, rgba(255,255,255,0.4), transparent),
    radial-gradient(1px 1px at 47% 73%, rgba(0,174,239,0.5), transparent),
    radial-gradient(1px 1px at 82% 27%, rgba(255,255,255,0.3), transparent),
    radial-gradient(1px 1px at 33% 88%, rgba(124,58,237,0.4), transparent),
    radial-gradient(1px 1px at 67% 52%, rgba(255,255,255,0.35), transparent),
    radial-gradient(2px 2px at 15% 65%, rgba(0,174,239,0.6), transparent),
    radial-gradient(1px 1px at 89% 91%, rgba(255,255,255,0.5), transparent);
  background-size:100% 100%;
  z-index:0;
  pointer-events:none;
  opacity:0.7;
}

.app{position:relative;z-index:1;min-height:100vh;padding:24px;display:flex;flex-direction:column;}
.shell{max-width:1100px;width:100%;margin:0 auto;flex:1;display:flex;flex-direction:column;}

/* HEADER */
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:36px;padding-top:8px;}
.logo{font-size:18px;font-weight:900;letter-spacing:.2em;}
.logo .b{color:#00AEEF;text-shadow:0 0 24px rgba(0,174,239,.55);}
.logo .w{color:#fff;}
.logo .game{display:inline-block;margin-left:14px;padding:4px 12px;background:linear-gradient(135deg,#00AEEF,#7C3AED);color:#fff;border-radius:999px;font-size:11px;letter-spacing:.16em;text-shadow:none;font-weight:800;}
.player-pill{display:flex;align-items:center;gap:10px;padding:8px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:999px;font-size:12px;color:#9CA3AF;}
.player-pill .xp{color:#00AEEF;font-weight:900;}
.player-pill .name{color:#fff;font-weight:700;}

/* SPLASH SCREEN */
.splash{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 20px;}
.splash h1{
  font-size:clamp(40px,7vw,80px);
  font-weight:900;
  line-height:1;
  letter-spacing:-.02em;
  background:linear-gradient(120deg,#00AEEF 0%,#7C3AED 50%,#EC4899 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  margin-bottom:18px;
  filter:drop-shadow(0 4px 28px rgba(0,174,239,.3));
  animation:slideUp .8s ease-out;
}
.splash .tag{
  font-size:18px;color:#9CA3AF;margin-bottom:40px;max-width:560px;line-height:1.6;
  animation:slideUp 1s ease-out;
}
.splash .tag b{color:#fff;font-weight:600;}
@keyframes slideUp{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:translateY(0);}}

.start-card{
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(255,255,255,0.08);
  border-radius:18px;
  padding:32px;
  width:100%;
  max-width:440px;
  backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
  box-shadow:0 8px 40px rgba(0,0,0,0.3),inset 0 1px 0 rgba(255,255,255,0.05);
  animation:slideUp 1.2s ease-out;
}
.start-card label{display:block;margin-bottom:18px;text-align:left;}
.start-card label span{display:block;font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.14em;font-weight:800;margin-bottom:8px;}
.start-card input,.start-card select{
  width:100%;padding:14px 16px;background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,255,255,0.1);border-radius:10px;
  color:#fff;font-size:15px;font-family:inherit;
  transition:border-color .2s,background .2s;
}
.start-card input:focus,.start-card select:focus{outline:none;border-color:#00AEEF;background:rgba(0,174,239,0.06);}
.start-card select option{background:#0A0F1E;color:#fff;}
.btn-primary{
  width:100%;padding:16px 24px;
  background:linear-gradient(135deg,#00AEEF 0%,#7C3AED 100%);
  border:0;color:#fff;border-radius:12px;
  font-size:15px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;
  cursor:pointer;
  box-shadow:0 8px 24px rgba(0,174,239,.35);
  transition:transform .15s,box-shadow .15s,filter .15s;
  font-family:inherit;
}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(0,174,239,.45);filter:brightness(1.08);}
.btn-primary:active{transform:translateY(0);}
.btn-primary:disabled{opacity:.5;cursor:wait;}

/* LEVEL MAP */
.map-head{margin-bottom:32px;}
.map-head h2{font-size:36px;font-weight:900;letter-spacing:-.01em;margin-bottom:6px;}
.map-head p{color:#9CA3AF;font-size:14px;}
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:36px;}
.stat-card{
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(255,255,255,0.08);
  border-radius:12px;
  padding:14px 18px;
  backdrop-filter:blur(8px);
  -webkit-backdrop-filter:blur(8px);
}
.stat-label{font-size:10px;color:#6B7280;text-transform:uppercase;letter-spacing:.14em;font-weight:800;}
.stat-num{font-size:28px;font-weight:900;line-height:1.2;letter-spacing:-.02em;margin-top:4px;}
.stat-num.xp{background:linear-gradient(120deg,#00AEEF,#EC4899);-webkit-background-clip:text;background-clip:text;color:transparent;}

.level-grid{display:flex;flex-direction:column;gap:18px;margin-bottom:32px;}
.level-card{
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(255,255,255,0.08);
  border-radius:18px;
  padding:24px 28px;
  display:flex;align-items:center;gap:24px;
  position:relative;
  backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
  transition:transform .25s,border-color .25s,box-shadow .25s;
}
.level-card.unlocked{cursor:pointer;}
.level-card.unlocked:hover{
  transform:translateY(-3px);
  border-color:rgba(255,255,255,0.16);
  box-shadow:0 12px 32px rgba(0,0,0,.35);
}
.level-card.locked{opacity:.45;filter:grayscale(0.6);}
.level-card.completed{
  border-color:rgba(34,211,238,0.35);
  box-shadow:0 0 0 1px rgba(34,211,238,0.15),0 8px 28px rgba(34,211,238,0.08);
}
.level-card.completed::before{
  content:'';position:absolute;inset:-1px;border-radius:18px;
  background:linear-gradient(135deg,rgba(34,211,238,0.4),transparent 50%,rgba(124,58,237,0.3));
  z-index:-1;filter:blur(8px);
  opacity:.6;
}

.level-num{
  width:64px;height:64px;border-radius:18px;display:flex;align-items:center;justify-content:center;
  font-size:28px;font-weight:900;flex-shrink:0;position:relative;
  background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);
  transition:all .25s;
}
.level-card.unlocked .level-num{
  background:linear-gradient(135deg,var(--lvl-color,#00AEEF),rgba(0,0,0,.2));
  border-color:rgba(255,255,255,0.18);
  box-shadow:0 0 28px var(--lvl-glow,rgba(0,174,239,.3)),inset 0 1px 0 rgba(255,255,255,0.2);
  color:#fff;
}
.level-card.completed .level-num::after{
  content:'';position:absolute;top:-6px;right:-6px;width:24px;height:24px;border-radius:50%;
  background:#22D3EE;display:flex;align-items:center;justify-content:center;
  box-shadow:0 0 12px rgba(34,211,238,.6);
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%230A0F1E'><path d='M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z'/></svg>");
  background-position:center;background-repeat:no-repeat;background-size:18px;
}
.level-card.locked .level-num::after{
  content:'';position:absolute;inset:0;border-radius:18px;
  background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23E5E7EB' opacity='.7'><path d='M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z'/></svg>");
  background-position:center;background-repeat:no-repeat;background-size:24px;
}
.level-info{flex:1;min-width:0;}
.level-name{font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--lvl-color,#00AEEF);margin-bottom:4px;}
.level-card.locked .level-name{color:#6B7280;}
.level-title{font-size:20px;font-weight:800;color:#fff;margin-bottom:4px;letter-spacing:-.01em;}
.level-card.locked .level-title{color:#6B7280;}
.level-desc{font-size:13px;color:#9CA3AF;line-height:1.5;}
.level-meta{font-size:11px;color:#6B7280;margin-top:8px;text-transform:uppercase;letter-spacing:.1em;font-weight:700;}
.level-progress{font-size:12px;color:#22D3EE;font-weight:700;margin-top:6px;}

.level-arrow{
  font-size:24px;color:rgba(255,255,255,0.3);flex-shrink:0;
  transition:transform .25s,color .25s;
}
.level-card.unlocked:hover .level-arrow{color:#fff;transform:translateX(4px);}

/* SCENARIO PICKER */
.scenarios{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;}
.scenario-card{
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(255,255,255,0.08);
  border-radius:14px;
  padding:20px;cursor:pointer;
  transition:transform .2s,border-color .2s;
  position:relative;
}
.scenario-card:hover{transform:translateY(-3px);border-color:rgba(0,174,239,0.4);}
.scenario-card.passed{border-color:rgba(34,211,238,0.4);}
.scenario-card.passed::before{
  content:'PASSED';position:absolute;top:14px;right:14px;
  font-size:10px;font-weight:800;letter-spacing:.12em;
  padding:3px 8px;background:rgba(34,211,238,0.15);color:#22D3EE;border-radius:999px;
}
.persona-avatar{
  width:48px;height:48px;border-radius:50%;
  background:linear-gradient(135deg,var(--lvl-color,#00AEEF),rgba(124,58,237,0.6));
  display:flex;align-items:center;justify-content:center;
  font-weight:900;font-size:18px;color:#fff;margin-bottom:14px;
  box-shadow:0 4px 16px rgba(0,174,239,0.25);
}
.scenario-name{font-size:18px;font-weight:800;color:#fff;margin-bottom:4px;}
.scenario-tag{font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px;}
.scenario-preview{font-size:13px;color:#9CA3AF;line-height:1.5;font-style:italic;}
.scenario-cta{font-size:11px;font-weight:800;color:#00AEEF;margin-top:14px;text-transform:uppercase;letter-spacing:.12em;}

.back-btn{
  display:inline-flex;align-items:center;gap:6px;
  background:transparent;border:0;color:#9CA3AF;font-size:13px;cursor:pointer;
  padding:8px 0;margin-bottom:20px;font-family:inherit;font-weight:600;
}
.back-btn:hover{color:#fff;}

/* CHAT */
.chat-frame{
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(255,255,255,0.08);
  border-radius:18px;
  display:flex;flex-direction:column;height:calc(100vh - 160px);min-height:480px;
  overflow:hidden;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
}
.chat-header{padding:16px 22px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;}
.chat-persona-block{display:flex;align-items:center;gap:12px;}
.chat-persona-avatar{
  width:40px;height:40px;border-radius:50%;
  background:linear-gradient(135deg,#00AEEF,rgba(124,58,237,0.6));
  display:flex;align-items:center;justify-content:center;
  font-weight:900;font-size:15px;color:#fff;flex-shrink:0;
}
.chat-persona-meta{display:flex;flex-direction:column;}
.chat-persona-name{font-size:15px;font-weight:800;color:#fff;letter-spacing:-.01em;}
.chat-persona-sub{font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.1em;font-weight:700;}
.chat-end{
  padding:8px 16px;background:rgba(220,38,38,0.1);border:1px solid rgba(220,38,38,0.3);
  color:#FCA5A5;border-radius:999px;font-size:11px;font-weight:800;
  letter-spacing:.08em;text-transform:uppercase;cursor:pointer;font-family:inherit;
  transition:background .2s;
}
.chat-end:hover{background:rgba(220,38,38,0.18);}

.chat-body{flex:1;overflow-y:auto;padding:22px;display:flex;flex-direction:column;gap:10px;}
.bubble{max-width:78%;padding:12px 16px;border-radius:18px;font-size:14px;line-height:1.55;animation:fadeIn .25s ease-out;}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}
.bubble.prospect{background:rgba(255,255,255,0.06);color:#E5E7EB;align-self:flex-start;border-bottom-left-radius:6px;}
.bubble.rep{background:linear-gradient(135deg,#0284C7,#00AEEF);color:#fff;align-self:flex-end;border-bottom-right-radius:6px;box-shadow:0 4px 16px rgba(0,174,239,0.25);}
.bubble.thinking{background:rgba(255,255,255,0.04);color:#6B7280;align-self:flex-start;font-style:italic;border-bottom-left-radius:6px;}

.chat-input{padding:16px;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:10px;align-items:flex-end;}
.chat-input textarea{
  flex:1;padding:12px 16px;
  background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);
  border-radius:12px;color:#fff;font-size:14px;font-family:inherit;resize:none;
  min-height:46px;max-height:140px;line-height:1.4;transition:border-color .2s;
}
.chat-input textarea:focus{outline:none;border-color:#00AEEF;background:rgba(0,174,239,0.04);}
.chat-input button{
  padding:12px 22px;background:linear-gradient(135deg,#00AEEF,#7C3AED);
  border:0;color:#fff;border-radius:12px;font-size:14px;font-weight:800;cursor:pointer;
  font-family:inherit;letter-spacing:.04em;text-transform:uppercase;
  transition:transform .15s,filter .15s;flex-shrink:0;
}
.chat-input button:hover{filter:brightness(1.1);transform:translateY(-1px);}
.chat-input button:disabled{opacity:.5;cursor:wait;transform:none;}

/* SCORE SCREEN */
.score-screen{padding:24px 0;}
.celebration{
  text-align:center;padding:40px 24px;
  background:linear-gradient(135deg,rgba(0,174,239,0.08),rgba(124,58,237,0.08));
  border:1px solid rgba(255,255,255,0.1);
  border-radius:24px;margin-bottom:24px;position:relative;overflow:hidden;
  animation:slideUp .6s ease-out;
}
.celebration h2{
  font-size:clamp(34px,5vw,56px);font-weight:900;line-height:1;
  background:linear-gradient(120deg,#22D3EE,#7C3AED,#EC4899);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  letter-spacing:-.02em;margin-bottom:14px;
  filter:drop-shadow(0 4px 24px rgba(0,174,239,.4));
}
.celebration .sub{font-size:16px;color:#9CA3AF;margin-bottom:24px;max-width:520px;margin-left:auto;margin-right:auto;line-height:1.6;}
.celebration .score-display{
  display:inline-flex;align-items:baseline;gap:6px;font-weight:900;
  font-size:72px;letter-spacing:-.03em;
}
.celebration .score-display .of{font-size:24px;color:#9CA3AF;font-weight:700;}
.celebration.win .score-display{color:#22D3EE;text-shadow:0 0 32px rgba(34,211,238,0.5);}
.celebration.fail .score-display{color:#EC4899;}

.celebration.win h2::after{content:' 🎉';}

.confetti{position:fixed;inset:0;pointer-events:none;z-index:50;overflow:hidden;}
.confetti span{
  position:absolute;width:8px;height:14px;border-radius:2px;top:-20px;
  animation:confettiFall var(--dur,3s) ease-in forwards;
}
@keyframes confettiFall{
  0%{transform:translate(0,0) rotate(0);opacity:1;}
  100%{transform:translate(var(--dx,0),100vh) rotate(720deg);opacity:0;}
}

.scorecard-block{
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(255,255,255,0.08);
  border-radius:14px;padding:24px;margin-bottom:16px;
}
.section-eyebrow{font-size:10px;font-weight:800;color:#9CA3AF;text-transform:uppercase;letter-spacing:.14em;margin-bottom:14px;}
.cat-row{margin-top:14px;}
.cat-row-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;}
.cat-label{font-size:13px;font-weight:700;color:#fff;}
.cat-score{font-size:14px;font-weight:800;}
.cat-bar{background:rgba(255,255,255,0.08);border-radius:9999px;height:6px;overflow:hidden;}
.cat-bar-fill{height:6px;border-radius:9999px;transition:width .8s cubic-bezier(.2,.7,.3,1);}
.cat-explainer{font-size:12px;color:#9CA3AF;line-height:1.55;margin-top:6px;}
.coaching{
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(255,255,255,0.08);
  border-left:3px solid #00AEEF;
  border-radius:10px;padding:22px 24px;margin-bottom:16px;
}
.coaching .head{font-size:11px;font-weight:800;color:#22D3EE;text-transform:uppercase;letter-spacing:.14em;margin-bottom:14px;}
.coaching .body{font-size:14px;color:#E5E7EB;line-height:1.7;}
.coaching .body p{margin-top:12px;}
.coaching .body p:first-child{margin-top:0;}

.btn-row{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;}
.btn-secondary{
  padding:14px 24px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);
  color:#fff;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;
  font-family:inherit;letter-spacing:.04em;
  transition:background .15s;
}
.btn-secondary:hover{background:rgba(255,255,255,0.1);}

.hidden{display:none !important;}
.spinner-row{display:flex;align-items:center;gap:12px;margin-top:14px;justify-content:center;}
.spinner{width:18px;height:18px;border:2px solid rgba(255,255,255,0.1);border-top-color:#00AEEF;border-radius:50%;animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}

@media(max-width:640px){
  .level-card{padding:18px;gap:16px;}
  .level-num{width:52px;height:52px;font-size:22px;}
  .level-title{font-size:17px;}
  .stats-row{grid-template-columns:repeat(2,1fr);}
}
</style></head><body>

<div class="app">
  <div class="shell">

    <div class="header">
      <div class="logo"><span class="b">AIRA</span><span class="w">FITNESS</span><span class="game">CLOSING GAME</span></div>
      <div id="player-pill" class="player-pill hidden">
        <span class="name" id="pp-name">Player</span> · <span class="xp"><span id="pp-xp">0</span> XP</span>
      </div>
    </div>

    <!-- SPLASH -->
    <div id="splash" class="splash">
      <h1>Become an Expert Closer</h1>
      <p class="tag">Five levels. Eleven prospects. Every objection you'll hear on the floor — simulated, scored, and coached. Beat each level to unlock the next. <b>Let's see how good you really are.</b></p>
      <div class="start-card">
        <label><span>Your Email <span style="color:#EC4899;">*</span></span><input id="player-email" type="email" placeholder="you@airafitness.com" required autocomplete="email" /></label>
        <label><span>Your Name</span><input id="player-name" placeholder="e.g. Alex" maxlength="32" autocomplete="name" /></label>
        <label><span>Your Gym</span><select id="location"><option value="">— Select your gym —</option>${locOptions}</select></label>
        <button class="btn-primary" id="enter-btn">Enter the Game →</button>
        <div style="margin-top:14px;font-size:12px;color:rgba(255,255,255,0.5);text-align:center;line-height:1.55;">Your progress is saved to your email — sign in from any device to pick up where you left off.</div>
      </div>
    </div>

    <!-- LEVEL MAP -->
    <div id="map" class="hidden">
      <div class="map-head">
        <h2>Your Closer Path</h2>
        <p>Pass each level to unlock the next. Score 70+ and close the sale to clear a scenario.</p>
      </div>
      <div class="stats-row">
        <div class="stat-card"><div class="stat-label">Total XP</div><div class="stat-num xp" id="stat-xp">0</div></div>
        <div class="stat-card"><div class="stat-label">Closes</div><div class="stat-num" id="stat-closes">0</div></div>
        <div class="stat-card"><div class="stat-label">Attempts</div><div class="stat-num" id="stat-attempts">0</div></div>
        <div class="stat-card"><div class="stat-label">Highest Level</div><div class="stat-num" id="stat-level">1</div></div>
      </div>
      <div class="level-grid" id="level-grid"></div>
    </div>

    <!-- SCENARIO PICKER -->
    <div id="picker" class="hidden">
      <button class="back-btn" onclick="showMap()">← Back to levels</button>
      <div class="map-head">
        <h2 id="picker-title">Pick your prospect</h2>
        <p id="picker-desc"></p>
      </div>
      <div class="scenarios" id="scenarios"></div>
    </div>

    <!-- CHAT -->
    <div id="chat" class="chat-frame hidden">
      <div class="chat-header">
        <div class="chat-persona-block">
          <div class="chat-persona-avatar" id="chat-avatar">?</div>
          <div class="chat-persona-meta">
            <div class="chat-persona-name" id="chat-name">—</div>
            <div class="chat-persona-sub" id="chat-tag">Practicing</div>
          </div>
        </div>
        <button class="chat-end" id="end-btn">End &amp; Score</button>
      </div>
      <div class="chat-body" id="messages"></div>
      <div class="chat-input">
        <textarea id="rep-input" placeholder="What do you say to the prospect?" rows="1"></textarea>
        <button id="send-btn">Send</button>
      </div>
    </div>

    <!-- SCORE -->
    <div id="score" class="score-screen hidden"></div>

  </div>
</div>

<script>
const LEVELS = ${JSON.stringify(levelData)};
const $ = (id) => document.getElementById(id);
let PLAYER = { id: null, email: null, name: null, location_id: null, xp: 0, closes: 0, attempts: 0, scenarios_passed: [], highest_level: 1 };
let SESSION_ID = null;
let CURRENT_SCENARIO = null;
let CURRENT_LEVEL = null;

// ─── identity / progress ───
// Email is the source of truth — same email on any device gets the same progress.
// We still read/write a cookie for instant re-entry, but identification on the
// server is keyed by email, not the cookie.
function getCookiePlayerId(){
  const id = (document.cookie.match(/aira_player_id=([^;]+)/)||[])[1];
  return id ? decodeURIComponent(id) : null;
}
function setPlayerCookies(id, email){
  document.cookie = 'aira_player_id=' + encodeURIComponent(id) + '; path=/; max-age=15552000; SameSite=Lax';
  if (email) document.cookie = 'aira_player_email=' + encodeURIComponent(email) + '; path=/; max-age=15552000; SameSite=Lax';
}
function loadCachedProfile(){
  const e = (document.cookie.match(/aira_player_email=([^;]+)/)||[])[1];
  const n = (document.cookie.match(/aira_player_name=([^;]+)/)||[])[1];
  const l = (document.cookie.match(/aira_player_location=([^;]+)/)||[])[1];
  if (e) PLAYER.email = decodeURIComponent(e);
  if (n) PLAYER.name = decodeURIComponent(n);
  if (l) PLAYER.location_id = decodeURIComponent(l);
}
function saveProfile(){
  if (PLAYER.email) document.cookie = 'aira_player_email=' + encodeURIComponent(PLAYER.email) + '; path=/; max-age=15552000; SameSite=Lax';
  if (PLAYER.name) document.cookie = 'aira_player_name=' + encodeURIComponent(PLAYER.name) + '; path=/; max-age=15552000; SameSite=Lax';
  if (PLAYER.location_id) document.cookie = 'aira_player_location=' + encodeURIComponent(PLAYER.location_id) + '; path=/; max-age=15552000; SameSite=Lax';
}

async function identifyPlayer(email, name, location_id){
  const claim = getCookiePlayerId(); // if we already had a cookie session, claim its progress
  const r = await fetch('/airafitnessclosinggame/identify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name, location_id, claim_player_id: claim }),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || 'identify failed');
  PLAYER.id = d.player_id;
  PLAYER.email = d.email;
  if (d.display_name && !name) PLAYER.name = d.display_name;
  setPlayerCookies(d.player_id, d.email);
  return d;
}

async function fetchProgress(){
  try {
    const r = await fetch('/airafitnessclosinggame/progress?player_id=' + encodeURIComponent(PLAYER.id));
    const d = await r.json();
    if (!d.ok) return;
    PLAYER.xp = d.progress.total_xp;
    PLAYER.closes = d.progress.closes_total;
    PLAYER.attempts = d.progress.attempts_total;
    PLAYER.scenarios_passed = (d.progress.per_scenario || []).filter(s => s.passed).map(s => s.scenario_id);
    if (d.progress.player_name && !PLAYER.name) PLAYER.name = d.progress.player_name;
    PLAYER.highest_level = computeHighestUnlocked();
    refreshHeader();
  } catch (e) { console.error('progress fetch failed', e); }
}

function computeHighestUnlocked(){
  // Level N is unlocked if level N-1 had at least one scenario passed (or if N=1 — always unlocked)
  let highest = 1;
  for (let i=0;i<LEVELS.length;i++){
    const lvl = LEVELS[i];
    const passedAny = lvl.scenarios.some(s => PLAYER.scenarios_passed.includes(s.id));
    if (passedAny && i+1 < LEVELS.length) highest = Math.max(highest, i+2);
  }
  return highest;
}

function refreshHeader(){
  $('player-pill').classList.remove('hidden');
  $('pp-name').textContent = PLAYER.name || 'Player';
  $('pp-xp').textContent = PLAYER.xp;
  $('stat-xp').textContent = PLAYER.xp;
  $('stat-closes').textContent = PLAYER.closes;
  $('stat-attempts').textContent = PLAYER.attempts;
  $('stat-level').textContent = PLAYER.highest_level;
}

// ─── splash ───
$('enter-btn').onclick = async () => {
  const email = $('player-email').value.trim();
  const name = $('player-name').value.trim();
  const loc = $('location').value;
  if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) { alert('Enter a valid email'); return; }
  if (!loc) { alert('Pick your gym to continue'); return; }
  $('enter-btn').disabled = true;
  $('enter-btn').textContent = 'Loading…';
  try {
    PLAYER.name = name || 'Player';
    PLAYER.location_id = loc;
    const ident = await identifyPlayer(email, name, loc);
    saveProfile();
    if (ident.claimed) console.log('[Game] Claimed prior progress for ' + email);
    await fetchProgress();
    showMap();
  } catch (err) {
    alert('Error: ' + err.message);
    $('enter-btn').disabled = false;
    $('enter-btn').textContent = 'Enter the Game →';
  }
};

// ─── level map ───
function showMap(){
  $('splash').classList.add('hidden');
  $('picker').classList.add('hidden');
  $('chat').classList.add('hidden');
  $('score').classList.add('hidden');
  $('map').classList.remove('hidden');
  renderLevels();
}
function renderLevels(){
  const grid = $('level-grid');
  grid.innerHTML = '';
  LEVELS.forEach((lvl, idx) => {
    const passed = lvl.scenarios.filter(s => PLAYER.scenarios_passed.includes(s.id)).length;
    const total = lvl.scenarios.length;
    const unlocked = idx === 0 || LEVELS[idx-1].scenarios.some(s => PLAYER.scenarios_passed.includes(s.id));
    const completed = passed >= 1;
    const card = document.createElement('div');
    card.className = 'level-card ' + (unlocked ? 'unlocked ' : 'locked ') + (completed ? 'completed' : '');
    card.style.setProperty('--lvl-color', lvl.color);
    card.style.setProperty('--lvl-glow', lvl.color + '55');
    card.innerHTML =
      '<div class="level-num">' + lvl.level + '</div>' +
      '<div class="level-info">' +
        '<div class="level-name">Level ' + lvl.level + ' · ' + lvl.name + '</div>' +
        '<div class="level-title">' + lvl.title + '</div>' +
        '<div class="level-desc">' + lvl.description + '</div>' +
        '<div class="level-progress">' + passed + ' / ' + total + ' scenarios cleared' + (completed ? ' · level passed' : '') + '</div>' +
      '</div>' +
      '<div class="level-arrow">→</div>';
    if (unlocked) card.onclick = () => showPicker(lvl);
    grid.appendChild(card);
  });
}

// ─── scenario picker ───
function showPicker(lvl){
  CURRENT_LEVEL = lvl;
  $('map').classList.add('hidden');
  $('picker').classList.remove('hidden');
  $('picker-title').textContent = 'Level ' + lvl.level + ' — ' + lvl.title;
  $('picker-desc').textContent = lvl.description;
  const cont = $('scenarios');
  cont.innerHTML = '';
  lvl.scenarios.forEach(sc => {
    const passed = PLAYER.scenarios_passed.includes(sc.id);
    const card = document.createElement('div');
    card.className = 'scenario-card' + (passed ? ' passed' : '');
    card.style.setProperty('--lvl-color', lvl.color);
    card.innerHTML =
      '<div class="persona-avatar" style="background:linear-gradient(135deg,' + lvl.color + ',rgba(124,58,237,0.6));">' + sc.name[0] + '</div>' +
      '<div class="scenario-name">' + sc.name + '</div>' +
      '<div class="scenario-tag">' + sc.difficulty.toUpperCase() + '</div>' +
      '<div class="scenario-preview">"' + (sc.opening.length > 130 ? sc.opening.slice(0,130)+'…' : sc.opening) + '"</div>' +
      '<div class="scenario-cta">' + (passed ? 'Try Again →' : 'Start Consult →') + '</div>';
    card.onclick = () => startSession(sc, lvl);
    cont.appendChild(card);
  });
}

// ─── chat session ───
async function startSession(sc, lvl){
  CURRENT_SCENARIO = sc;
  $('picker').classList.add('hidden');
  $('chat').classList.remove('hidden');
  $('messages').innerHTML = '';
  $('chat-name').textContent = sc.name;
  $('chat-tag').textContent = lvl.name + ' · Level ' + lvl.level;
  $('chat-avatar').textContent = sc.name[0];
  $('chat-avatar').style.background = 'linear-gradient(135deg,' + lvl.color + ',rgba(124,58,237,0.6))';

  const r = await postJson('/practice/start', {
    difficulty: sc.difficulty,
    location_id: PLAYER.location_id,
    mode: 'game',
    player_id: PLAYER.id,
    player_name: PLAYER.name,
    scenario_id: sc.id,
  });
  if (!r.ok) { alert('Error: ' + r.error); return; }
  SESSION_ID = r.session_id;
  bubble('prospect', r.opening);
  $('rep-input').focus();
}

function bubble(role, text){
  const div = document.createElement('div');
  div.className = 'bubble ' + role;
  div.textContent = text;
  $('messages').appendChild(div);
  $('messages').scrollTop = $('messages').scrollHeight;
  return div;
}
async function postJson(url, body){
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  return r.json();
}
const repInput = $('rep-input');
repInput.addEventListener('input', () => { repInput.style.height='auto'; repInput.style.height=Math.min(repInput.scrollHeight,140)+'px'; });
repInput.addEventListener('keydown', (e) => { if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); $('send-btn').click(); }});
$('send-btn').onclick = async () => {
  const msg = repInput.value.trim(); if (!msg) return;
  bubble('rep', msg); repInput.value=''; repInput.style.height='auto';
  $('send-btn').disabled = true;
  const thinking = bubble('thinking', 'thinking…');
  const r = await postJson('/practice/turn', { session_id: SESSION_ID, message: msg });
  thinking.remove();
  $('send-btn').disabled = false;
  if (!r.ok){ bubble('prospect', '[error: '+r.error+']'); return; }
  bubble('prospect', r.reply);
  repInput.focus();
};

$('end-btn').onclick = async () => {
  if (!confirm('End the consult and get scored?')) return;
  $('end-btn').disabled = true;
  $('chat').classList.add('hidden');
  $('score').classList.remove('hidden');
  $('score').innerHTML = '<div class="celebration"><h2>Scoring…</h2><p class="sub">Analyzing your full conversation. This takes 20-40 seconds — don\\'t close the tab.</p><div class="spinner-row"><div class="spinner"></div><div style="color:#9CA3AF;font-size:13px;">Reading every move you made…</div></div></div>';
  try {
    const r = await postJson('/practice/end', { session_id: SESSION_ID });
    if (!r.ok){
      $('score').innerHTML = '<div class="celebration fail"><h2>Hmm</h2><p class="sub">'+r.error+'</p><button class="btn-secondary" onclick="showMap()">Back to Levels</button></div>';
      return;
    }
    await fetchProgress();
    renderResult(r.scorecard, r.messages);
  } catch (err) {
    $('score').innerHTML = '<div class="celebration fail"><h2>Connection Error</h2><p class="sub">Couldn\\'t reach the scorer. '+(err.message||err)+'</p><button class="btn-secondary" onclick="$(\\'end-btn\\').click()">Try Again</button></div>';
  }
};

function colorFor(score, max){ const p=(score/max)*100; return p>=70?'#22D3EE':p>=50?'#0284C7':'#EC4899'; }

function renderResult(s, messages){
  const total = s.total_score || 0;
  const closed = s.did_close === true;
  const passed = closed && total >= 70;
  const win = passed;

  if (win) launchConfetti();

  const headline = win
    ? (total >= 90 ? 'PERFECT CLOSE' : 'LEVEL CLEARED')
    : (closed ? 'CLOSED — BUT NOT QUITE' : 'PROSPECT WALKED');
  const sub = win
    ? 'You earned ' + total + ' XP. The next level is unlocked.'
    : (closed ? 'You closed at ' + total + ' — passing requires 70+ AND a closed sale.' : 'No sale today. The script knows where the gap was — read the coaching below.');

  const cats = [
    ['Sit-Down Presentation', s.sitdown_score||0, s.sitdown_score_explainer],
    ['Objection Handling', s.objection_score||0, s.objection_score_explainer],
    ['Language & Psychology', s.language_score||0, s.language_score_explainer],
    ['Close Execution', s.close_score||0, s.close_score_explainer],
  ];
  const catHtml = cats.map(([l,sc,e]) => {
    const c = colorFor(sc,25); const p=(sc/25)*100;
    return '<div class="cat-row"><div class="cat-row-head"><div class="cat-label">'+l+'</div><div class="cat-score" style="color:'+c+';">'+sc+'<span style="color:#6B7280;font-weight:600;"> / 25</span></div></div><div class="cat-bar"><div class="cat-bar-fill" style="background:'+c+';width:'+p+'%;"></div></div>'+(e?'<div class="cat-explainer">'+e+'</div>':'')+'</div>';
  }).join('');

  const coaching = (s.overall_coaching || s.coaching_note || '').trim();
  const coachHtml = coaching ? '<div class="coaching"><div class="head">Coaching Notes</div><div class="body"><p>'+coaching.replace(/\\n\\n+/g,'</p><p>').replace(/\\n/g,' ')+'</p></div></div>' : '';

  const convoHtml = (messages && messages.length) ? '<div class="scorecard-block"><div class="section-eyebrow">The Conversation</div>' + messages.map(m=>{
    const isRep = m.role==='user';
    const lblColor = isRep?'#00AEEF':'#9CA3AF';
    const bg = isRep?'rgba(0,174,239,0.06)':'rgba(255,255,255,0.04)';
    const border = isRep?'rgba(0,174,239,0.2)':'rgba(255,255,255,0.08)';
    const safe = String(m.content||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return '<div style="background:'+bg+';border:1px solid '+border+';border-radius:8px;padding:10px 14px;margin-bottom:8px;"><div style="font-size:10px;font-weight:800;letter-spacing:.14em;color:'+lblColor+';margin-bottom:4px;">'+(isRep?'YOU SAID':'PROSPECT SAID')+'</div><div style="font-size:13.5px;color:#E5E7EB;line-height:1.55;">'+safe+'</div></div>';
  }).join('') + '</div>' : '';

  const nextLevel = win && CURRENT_LEVEL && CURRENT_LEVEL.level < LEVELS.length ? LEVELS[CURRENT_LEVEL.level] : null;
  const nextBtn = nextLevel ? '<button class="btn-primary" onclick="showPicker(LEVELS['+(nextLevel.level-1)+'])">Next: Level '+nextLevel.level+' — '+nextLevel.name+' →</button>' : '';
  const retryBtn = '<button class="btn-secondary" onclick="showPicker(LEVELS['+(CURRENT_LEVEL.level-1)+'])">Try Again</button>';
  const mapBtn = '<button class="btn-secondary" onclick="showMap()">Back to Levels</button>';

  $('score').innerHTML =
    '<div class="celebration ' + (win?'win':'fail') + '">' +
      '<h2>' + headline + '</h2>' +
      '<p class="sub">' + sub + '</p>' +
      '<div class="score-display">' + total + '<span class="of">/ 100</span></div>' +
    '</div>' +
    '<div class="scorecard-block"><div class="section-eyebrow">Score Breakdown</div>' + catHtml + '</div>' +
    coachHtml +
    convoHtml +
    '<div class="btn-row">' + nextBtn + retryBtn + mapBtn + '</div>';
}

function launchConfetti(){
  const colors = ['#00AEEF','#22D3EE','#7C3AED','#EC4899','#FBBF24','#fff'];
  const wrap = document.createElement('div');
  wrap.className = 'confetti';
  for (let i=0;i<80;i++){
    const s = document.createElement('span');
    s.style.left = (Math.random()*100)+'%';
    s.style.background = colors[Math.floor(Math.random()*colors.length)];
    s.style.setProperty('--dx', ((Math.random()-0.5)*240)+'px');
    s.style.setProperty('--dur', (2.6+Math.random()*1.4)+'s');
    s.style.animationDelay = (Math.random()*0.4)+'s';
    wrap.appendChild(s);
  }
  document.body.appendChild(wrap);
  setTimeout(()=>wrap.remove(), 5000);
}

// ─── boot ───
loadCachedProfile();
const cookiePlayerId = getCookiePlayerId();
if (PLAYER.email && cookiePlayerId){
  // Returning player — restore the form values, set the canonical id, and fetch progress.
  PLAYER.id = cookiePlayerId;
  $('player-email').value = PLAYER.email;
  if (PLAYER.name) $('player-name').value = PLAYER.name;
  if (PLAYER.location_id) $('location').value = PLAYER.location_id;
  fetchProgress().then(()=>{
    if (PLAYER.attempts > 0) showMap(); // skip splash, go straight to level map
  });
}
</script>
</body></html>`);
});

app.get("/practice", (req, res) => {
  const locOptions = ALL_LOCATIONS.map(
    (l) => `<option value="${l.location_id}">${l.franchise_name}</option>`,
  ).join("");
  const diffOptions = Object.entries(PROSPECT_PERSONAS)
    .map(
      ([k, p]) =>
        `<option value="${k}"${k === "medium" ? " selected" : ""}>${p.label} — ${p.description}</option>`,
    )
    .join("");

  res.send(`<!DOCTYPE html><html><head><title>Aira Practice — Objection Bot</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:#EEF1F4;color:#111827;-webkit-font-smoothing:antialiased;height:100vh;display:flex;flex-direction:column;}
a{color:#0284C7;}
.brand{background:#0A0A0A;padding:18px 28px;text-align:center;flex-shrink:0;}
.brand-mark{font-size:20px;font-weight:900;letter-spacing:.18em;line-height:1;}
.brand-mark .b{color:#00AEEF;} .brand-mark .w{color:#fff;}
.subhead{background:#fff;border-bottom:3px solid #00AEEF;padding:18px 28px;flex-shrink:0;}
.subhead-inner{max-width:760px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;}
.eyebrow{font-size:10px;font-weight:800;color:#00AEEF;letter-spacing:.18em;text-transform:uppercase;margin-bottom:4px;}
.title{font-size:20px;font-weight:900;color:#0A0A0A;letter-spacing:-.01em;}
.subtitle{font-size:12px;color:#6B7280;margin-top:2px;}
.back{font-size:12px;color:#6B7280;text-decoration:none;font-weight:600;}
.back:hover{color:#0A0A0A;}

.stage{flex:1;display:flex;flex-direction:column;max-width:760px;width:100%;margin:0 auto;padding:20px 24px;min-height:0;}

.start-screen{background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:32px;}
.start-eyebrow{font-size:11px;font-weight:800;color:#00AEEF;letter-spacing:.14em;text-transform:uppercase;margin-bottom:8px;}
.start-title{font-size:24px;font-weight:900;color:#0A0A0A;letter-spacing:-.01em;margin-bottom:8px;}
.start-body{font-size:14px;color:#6B7280;line-height:1.6;margin-bottom:20px;}
label.fld{display:block;margin-bottom:14px;}
label.fld span{display:block;font-size:11px;font-weight:800;color:#6B7280;text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px;}
label.fld select{width:100%;padding:10px 12px;border:1px solid #D1D5DB;border-radius:6px;font-size:14px;background:#fff;font-family:inherit;}
button.cta{display:inline-block;padding:12px 28px;background:#0A0A0A;color:#fff;border:0;border-radius:6px;font-size:14px;font-weight:700;cursor:pointer;letter-spacing:.02em;}
button.cta:hover{background:#1F2937;}
button.cta.secondary{background:#fff;color:#0A0A0A;border:1px solid #D1D5DB;}
button.cta.secondary:hover{background:#F3F4F6;}
button.cta:disabled{opacity:.5;cursor:not-allowed;}

.chat-frame{background:#fff;border:1px solid #E5E7EB;border-radius:10px;display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;}
.chat-header{padding:14px 18px;border-bottom:1px solid #F3F4F6;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;}
.chat-persona{font-size:12px;color:#6B7280;font-weight:600;}
.chat-persona b{color:#0A0A0A;}
.chat-end{padding:6px 14px;background:#fff;border:1px solid #DC2626;color:#DC2626;border-radius:9999px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;}
.chat-end:hover{background:#FEE2E2;}

.chat-body{flex:1;overflow-y:auto;padding:18px;background:#F9FAFB;display:flex;flex-direction:column;gap:10px;}
.bubble{max-width:80%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.5;}
.bubble.prospect{background:#fff;border:1px solid #E5E7EB;color:#111827;align-self:flex-start;border-bottom-left-radius:4px;}
.bubble.rep{background:#0A0A0A;color:#fff;align-self:flex-end;border-bottom-right-radius:4px;}
.bubble.thinking{background:#fff;border:1px solid #E5E7EB;color:#9CA3AF;align-self:flex-start;font-style:italic;border-bottom-left-radius:4px;}

.chat-input{padding:14px;border-top:1px solid #F3F4F6;display:flex;gap:10px;flex-shrink:0;background:#fff;}
.chat-input textarea{flex:1;padding:10px 14px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;font-family:inherit;resize:none;min-height:42px;max-height:140px;line-height:1.4;}
.chat-input textarea:focus{outline:none;border-color:#00AEEF;}
.chat-input button{padding:10px 20px;background:#00AEEF;color:#fff;border:0;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;}
.chat-input button:hover{background:#0284C7;}
.chat-input button:disabled{background:#9CA3AF;cursor:not-allowed;}

.score-screen{background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:28px;}
.score-eyebrow{font-size:10px;font-weight:800;color:#00AEEF;letter-spacing:.14em;text-transform:uppercase;margin-bottom:8px;}
.score-title{font-size:22px;font-weight:900;color:#0A0A0A;letter-spacing:-.01em;margin-bottom:18px;}
.score-big-wrap{text-align:center;padding:22px;background:#F9FAFB;border-radius:8px;margin-bottom:18px;}
.score-label{font-size:10px;color:#6B7280;text-transform:uppercase;letter-spacing:.14em;font-weight:800;}
.score-num{font-size:54px;font-weight:900;line-height:1.05;margin-top:6px;letter-spacing:-.02em;}
.score-num span{font-size:20px;color:#9CA3AF;font-weight:600;}
.closed-pill{display:inline-block;padding:6px 14px;background:#0A0A0A;color:#fff;border-radius:9999px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-top:10px;}
.closed-pill.no{background:#fff;border:1px solid #DC2626;color:#DC2626;}
.score-summary{padding:14px 16px;background:#F9FAFB;border-left:3px solid #00AEEF;border-radius:4px;margin-bottom:14px;font-size:13px;color:#111827;line-height:1.55;}
.cat-row{margin-top:14px;}
.cat-row-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;}
.cat-label{font-size:13px;font-weight:700;color:#111827;}
.cat-score{font-size:14px;font-weight:800;}
.cat-bar{background:#F3F4F6;border-radius:9999px;height:6px;overflow:hidden;}
.cat-bar-fill{height:6px;border-radius:9999px;}
.coaching{background:#fff;border:1px solid #E5E7EB;border-left:4px solid #00AEEF;border-radius:6px;padding:18px 20px;margin-top:18px;font-size:14px;color:#111827;line-height:1.65;}
.coaching p{margin-top:10px;}
.coaching p:first-child{margin-top:0;}
.coaching-header{font-size:11px;font-weight:800;color:#0A0A0A;text-transform:uppercase;letter-spacing:.14em;margin-bottom:12px;}
.btn-row{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap;}
.conversation{margin-top:18px;background:#fff;border:1px solid #E5E7EB;border-radius:6px;padding:18px 20px;}
.spinner-row{display:flex;align-items:center;gap:14px;margin-top:18px;}
.spinner{width:20px;height:20px;border:2.5px solid #E5E7EB;border-top-color:#00AEEF;border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0;}
@keyframes spin{to{transform:rotate(360deg);}}

.hidden{display:none !important;}
</style></head><body>

<div class="brand"><div class="brand-mark"><span class="b">AIRA</span>&nbsp;<span class="w">FITNESS</span></div></div>
<div class="subhead"><div class="subhead-inner">
  <div>
    <div class="eyebrow">Practice</div>
    <div class="title">Objection Bot</div>
    <div class="subtitle">Run a mock consult against an AI prospect. Get scored at the end.</div>
  </div>
</div></div>

<div class="stage">

  <div id="start" class="start-screen">
    <div class="start-eyebrow">Set up your consult</div>
    <div class="start-title">Pick a prospect to practice against</div>
    <div class="start-body">A new prospect walks into your gym. You greet them, sit them down, present pricing, handle objections, and close the sale. The bot reacts to what you actually say — same psychology as your real consults. You can end the consult any time and get scored.</div>

    <label class="fld"><span>Difficulty</span>
      <select id="difficulty">${diffOptions}</select>
    </label>
    <label class="fld"><span>Your Location</span>
      <select id="location">
        <option value="">— Select your gym —</option>
        ${locOptions}
      </select>
    </label>
    <button class="cta" id="start-btn">Start Consult →</button>
  </div>

  <div id="chat" class="chat-frame hidden">
    <div class="chat-header">
      <div class="chat-persona">Practicing against: <b id="persona-label">—</b></div>
      <button class="chat-end" id="end-btn">End &amp; Score</button>
    </div>
    <div class="chat-body" id="messages"></div>
    <div class="chat-input">
      <textarea id="rep-input" placeholder="What do you say to the prospect?" rows="1"></textarea>
      <button id="send-btn">Send</button>
    </div>
  </div>

  <div id="score" class="score-screen hidden"></div>

</div>

<script>
const $ = (id) => document.getElementById(id);
let SESSION_ID = null;
let SCENARIO_ID = '';

// Track recently-seen scenario IDs so the next session picks something different.
function rememberScenario(id) {
  if (!id) return;
  const existing = (document.cookie.match(/aira_seen=([^;]+)/) || [])[1] || '';
  const seen = decodeURIComponent(existing).split(',').filter(Boolean);
  const updated = [id, ...seen.filter(s => s !== id)].slice(0, 6);
  document.cookie = 'aira_seen=' + encodeURIComponent(updated.join(',')) + '; path=/; max-age=2592000; SameSite=Lax';
}

function bubble(role, text) {
  const div = document.createElement('div');
  div.className = 'bubble ' + role;
  div.textContent = text;
  $('messages').appendChild(div);
  $('messages').scrollTop = $('messages').scrollHeight;
  return div;
}

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  return r.json();
}

$('start-btn').onclick = async () => {
  const difficulty = $('difficulty').value;
  const location_id = $('location').value;
  if (!location_id) { alert('Please select your gym'); return; }
  $('start-btn').disabled = true;
  $('start-btn').textContent = 'Starting…';
  const r = await postJson('/practice/start', { difficulty, location_id });
  if (!r.ok) { alert('Error: ' + r.error); $('start-btn').disabled = false; $('start-btn').textContent = 'Start Consult →'; return; }
  SESSION_ID = r.session_id;
  SCENARIO_ID = r.scenario_id || '';
  $('persona-label').textContent = r.persona_label + (r.persona_name ? ' — ' + r.persona_name : '');
  $('start').classList.add('hidden');
  $('chat').classList.remove('hidden');
  bubble('prospect', r.opening);
  $('rep-input').focus();
};

const repInput = $('rep-input');
repInput.addEventListener('input', () => {
  repInput.style.height = 'auto';
  repInput.style.height = Math.min(repInput.scrollHeight, 140) + 'px';
});
repInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send-btn').click(); }
});

$('send-btn').onclick = async () => {
  const msg = repInput.value.trim();
  if (!msg) return;
  bubble('rep', msg);
  repInput.value = '';
  repInput.style.height = 'auto';
  $('send-btn').disabled = true;
  const thinking = bubble('thinking', 'thinking…');
  const r = await postJson('/practice/turn', { session_id: SESSION_ID, message: msg });
  thinking.remove();
  $('send-btn').disabled = false;
  if (!r.ok) { bubble('prospect', '[error: ' + r.error + ']'); return; }
  bubble('prospect', r.reply);
  repInput.focus();
};

$('end-btn').onclick = async () => {
  if (!confirm('End the consult and get scored?')) return;
  $('end-btn').disabled = true;
  $('chat').classList.add('hidden');
  $('score').classList.remove('hidden');
  $('score').innerHTML = '<div class="score-eyebrow">Scoring</div><div class="score-title">Analyzing your consult…</div><div class="spinner-row"><div class="spinner"></div><div style="color:#6B7280;font-size:13px;">This takes 20-40 seconds. Don\\'t refresh — your score is on the way.</div></div>';
  try {
    const r = await postJson('/practice/end', { session_id: SESSION_ID });
    if (!r.ok) {
      $('score').innerHTML = '<div class="score-eyebrow" style="color:#DC2626;">Error</div><div class="score-title">' + r.error + '</div><button class="cta" onclick="location.reload()">Start Over</button>';
      return;
    }
    rememberScenario(r.scenario_id || SCENARIO_ID);
    renderScorecard(r.scorecard, r.messages);
  } catch (err) {
    $('score').innerHTML = '<div class="score-eyebrow" style="color:#DC2626;">Connection Error</div><div class="score-title">Couldn\\'t reach the scorer.</div><div style="color:#6B7280;font-size:13px;margin-top:10px;">' + (err.message || err) + '</div><div class="btn-row"><button class="cta" onclick="$(\\'end-btn\\').click()">Try Again</button> <button class="cta secondary" onclick="location.reload()">Start Over</button></div>';
  }
};

function colorFor(score, max) {
  const pct = (score / max) * 100;
  return pct >= 70 ? '#00AEEF' : pct >= 50 ? '#0284C7' : '#DC2626';
}

function escapeHtml(t) {
  return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderConversation(messages) {
  if (!messages || !messages.length) return '';
  const rows = messages.map(m => {
    const isRep = m.role === 'user';
    const label = isRep ? 'YOU SAID' : 'PROSPECT SAID';
    const labelColor = isRep ? '#00AEEF' : '#6B7280';
    const bg = isRep ? '#F0FBFF' : '#F9FAFB';
    const border = isRep ? '#BAE6FD' : '#E5E7EB';
    return '<div style="background:' + bg + ';border:1px solid ' + border + ';border-radius:6px;padding:12px 14px;margin-bottom:8px;">' +
      '<div style="font-size:10px;font-weight:800;letter-spacing:.14em;color:' + labelColor + ';margin-bottom:4px;">' + label + '</div>' +
      '<div style="font-size:13.5px;color:#111827;line-height:1.55;">' + escapeHtml(m.content) + '</div>' +
    '</div>';
  }).join('');
  return '<div class="conversation"><div class="coaching-header" style="margin-bottom:10px;">The Conversation</div>' + rows + '</div>';
}

function renderScorecard(s, messages) {
  const total = s.total_score || 0;
  const totalColor = colorFor(total, 100);
  const closed = s.did_close === true;
  const sections = [
    ['Sit-Down Presentation', s.sitdown_score, s.sitdown_score_explainer],
    ['Objection Handling', s.objection_score, s.objection_score_explainer],
    ['Language & Psychology', s.language_score, s.language_score_explainer],
    ['Close Execution', s.close_score, s.close_score_explainer],
  ];
  const catRows = sections.map(([label, score, expl]) => {
    const c = colorFor(score, 25);
    const pct = (score / 25) * 100;
    return '<div class="cat-row"><div class="cat-row-head"><div class="cat-label">' + label + '</div><div class="cat-score" style="color:' + c + ';">' + score + '<span style="color:#9CA3AF;font-weight:600;"> / 25</span></div></div><div class="cat-bar"><div class="cat-bar-fill" style="background:' + c + ';width:' + pct + '%;"></div></div>' + (expl ? '<div style="font-size:13px;color:#6B7280;line-height:1.5;margin:6px 0 0;">' + expl + '</div>' : '') + '</div>';
  }).join('');
  const coaching = (s.overall_coaching || s.coaching_note || '').trim();
  const coachingHtml = coaching ? '<div class="coaching"><div class="coaching-header">Coaching Notes</div><p>' + coaching.replace(/\\n\\n+/g, '</p><p>').replace(/\\n/g, ' ') + '</p></div>' : '';

  $('score').innerHTML =
    '<div class="score-eyebrow">Practice Result</div>' +
    '<div class="score-title">Your Scorecard</div>' +
    '<div class="score-big-wrap"><div class="score-label">Overall Score</div><div class="score-num" style="color:' + totalColor + ';">' + total + '<span> / 100</span></div>' +
    (closed ? '<div class="closed-pill"><span style="color:#00AEEF;">✓</span> Sale Closed</div>' : '<div class="closed-pill no">No Sale</div>') +
    '</div>' +
    (s.ai_summary ? '<div class="score-summary">' + s.ai_summary + '</div>' : '') +
    catRows +
    coachingHtml +
    renderConversation(messages) +
    '<div class="btn-row"><button class="cta" onclick="location.reload()">Practice Again</button></div>';
}
</script>
</body></html>`);
});

app.get("/scorecard/:id", adminAuth, async (req, res) => {
  try {
    const r = await db.getRecording(req.params.id);
    if (!r) return res.status(404).send("Recording not found");
    const s = await db.getScorecardByRecording(req.params.id);
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
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const scoreColor =
      s.total_score >= 70
        ? "#00AEEF"
        : s.total_score >= 50
          ? "#0284C7"
          : "#DC2626";
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
    const closedBadge =
      s.did_close === true
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
  ${
    s.overall_coaching || s.coaching_note
      ? `<div class="coaching">
    <div class="coaching-header">Coaching Notes</div>
    <div class="coaching-body"><p>${(s.overall_coaching || s.coaching_note).replace(/\n\n+/g, "</p><p>").replace(/\n/g, " ")}</p></div>
  </div>`
      : ""
  }
  ${
    r.transcript
      ? `<div class="card">
    <div class="section-title">Full Transcript</div>
    <div class="transcript">${r.transcript}</div>
  </div>`
      : ""
  }
</div>
</body></html>`);
  } catch (err) {
    console.error("[Scorecard] Error:", err.message);
    res.status(500).send("Error loading scorecard: " + err.message);
  }
});

app.get("/playback/:recording_id", adminAuth, async (req, res) => {
  const rec = await db.getRecording(req.params.recording_id);
  if (!rec || !rec.audio_file_url) return res.status(404).send("Not found");
  const name = rec.contact_name || rec.appointment_id;
  const loc = byLocationId[rec.location_id] || {};
  const dt = new Date(rec.recorded_at).toLocaleString("en-US", {
    timeZone: "America/Chicago",
  });
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
  ${
    rec.transcript
      ? `<div class="card">
    <div class="section-title">Transcript</div>
    <div class="transcript">${rec.transcript}</div>
  </div>`
      : `<div class="card"><div style="color:#9CA3AF;font-size:13px;">No transcript yet</div></div>`
  }
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
// Merge any custom locations (added via /admin/locations) into the in-memory maps.
// Called at startup AND after each add/delete so changes propagate without restart.
async function loadCustomLocations() {
  try {
    const customs = await db.getCustomLocations();
    for (const c of customs) {
      const loc = {
        location_id: c.location_id,
        franchise_name: c.franchise_name,
        franchisee_name: c.franchisee_name || "",
        franchisee_email: c.franchisee_email,
        vp_email: c.vp_email || undefined,
        club_email: c.club_email || undefined,
        ghl_calendar_id: c.ghl_calendar_id || "",
        _custom: true,
      };
      byLocationId[loc.location_id] = loc;
      if (loc.ghl_calendar_id) byCalendarId[loc.ghl_calendar_id] = loc;
      if (!ALL_LOCATIONS.find((x) => x.location_id === loc.location_id)) {
        ALL_LOCATIONS.push(loc);
      }
    }
    console.log(`[Locations] Loaded ${customs.length} custom location(s)`);
  } catch (err) {
    console.error("[Locations] failed to load custom locations:", err.message);
  }
}

function removeCustomLocationFromCache(location_id) {
  const existing = byLocationId[location_id];
  if (!existing || !existing._custom) return false;
  delete byLocationId[location_id];
  if (existing.ghl_calendar_id) delete byCalendarId[existing.ghl_calendar_id];
  const idx = ALL_LOCATIONS.findIndex((x) => x.location_id === location_id);
  if (idx >= 0) ALL_LOCATIONS.splice(idx, 1);
  return true;
}

initDb()
  .then(async () => {
    await loadCustomLocations();
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
