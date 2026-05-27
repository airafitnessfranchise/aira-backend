// server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const axios = require("axios");
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
  voiceForPersona,
  buildVoiceInstructions,
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
    cb(null, Date.now() + "-" + uuidv4() + audioExtensionForUpload(file));
  },
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

const tabletConnections = new Map();
const recorderLocationAliases = new Map();

function audioExtensionForUpload(file) {
  const fromName = path.extname(file?.originalname || "").toLowerCase();
  if (
    [".m4a", ".mp4", ".webm", ".mp3", ".wav", ".mpeg", ".mpga"].includes(
      fromName,
    )
  ) {
    return fromName;
  }
  const mime = String(file?.mimetype || "").toLowerCase();
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac"))
    return ".m4a";
  if (mime.includes("mpeg") || mime.includes("mp3")) return ".mp3";
  if (mime.includes("wav")) return ".wav";
  return ".webm";
}

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

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function decodeBase64url(value) {
  let normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  return Buffer.from(normalized, "base64").toString("utf8");
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyStaffToken(token) {
  const secret = process.env.RECORDER_TOKEN_SECRET;
  if (!secret) throw new Error("missing_recorder_token_secret");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("malformed_recorder_token");
  const [encodedHeader, encodedPayload, signature] = parts;
  const header = JSON.parse(decodeBase64url(encodedHeader));
  const payload = JSON.parse(decodeBase64url(encodedPayload));
  if (header.alg !== "HS256" || header.typ !== "AIRA-RECORDER") {
    throw new Error("unsupported_recorder_token");
  }
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = base64url(
    crypto.createHmac("sha256", secret).update(signingInput).digest(),
  );
  if (!timingSafeEqual(signature, expected)) {
    throw new Error("invalid_recorder_token_signature");
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== "aira-api" || payload.aud !== "aira-backend") {
    throw new Error("invalid_recorder_token_claims");
  }
  if (payload.nbf && now + 60 < payload.nbf)
    throw new Error("recorder_token_not_yet_valid");
  if (!payload.exp || now - 60 > payload.exp)
    throw new Error("recorder_token_expired");
  if (!["super_admin", "vp", "franchisee"].includes(payload.role)) {
    throw new Error("recorder_token_role_denied");
  }
  return payload;
}

function signRecordingResultToken(recording) {
  const secret = process.env.RECORDER_TOKEN_SECRET;
  if (!secret || !recording?.recording_id) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "AIRA-RECORDING-RESULT" };
  const payload = {
    iss: "aira-backend",
    aud: "aira-staff-app",
    sub: recording.recording_id,
    location_id: recording.location_id || "unknown",
    iat: now,
    exp: now + 60 * 60 * 24 * 7,
  };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = base64url(
    crypto.createHmac("sha256", secret).update(signingInput).digest(),
  );
  return `${signingInput}.${signature}`;
}

function verifyRecordingResultToken(token, recordingId) {
  const secret = process.env.RECORDER_TOKEN_SECRET;
  if (!secret) throw new Error("missing_recorder_token_secret");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("malformed_recording_result_token");
  const [encodedHeader, encodedPayload, signature] = parts;
  const header = JSON.parse(decodeBase64url(encodedHeader));
  const payload = JSON.parse(decodeBase64url(encodedPayload));
  if (header.alg !== "HS256" || header.typ !== "AIRA-RECORDING-RESULT") {
    throw new Error("unsupported_recording_result_token");
  }
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = base64url(
    crypto.createHmac("sha256", secret).update(signingInput).digest(),
  );
  if (!timingSafeEqual(signature, expected)) {
    throw new Error("invalid_recording_result_token_signature");
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== "aira-backend" || payload.aud !== "aira-staff-app") {
    throw new Error("invalid_recording_result_token_claims");
  }
  if (!payload.exp || now - 60 > payload.exp) {
    throw new Error("recording_result_token_expired");
  }
  if (String(payload.sub || "") !== String(recordingId || "")) {
    throw new Error("recording_result_token_subject_mismatch");
  }
  return payload;
}

function normalizeLocationId(id) {
  return String(id || "")
    .toLowerCase()
    .trim();
}

function resolveRecorderLocationId(id) {
  const canonical = canonicalLocationId(id);
  return (
    recorderLocationAliases.get(normalizeLocationId(canonical)) || canonical
  );
}

function staffCanAccessLocation(req, locationId) {
  const staff = req.staff;
  if (!staff) return false;
  if (staff.is_super) return true;
  const resolved = resolveRecorderLocationId(locationId);
  return (staff.location_ids || [])
    .map(normalizeLocationId)
    .includes(normalizeLocationId(resolved));
}

function ensureStaffLocationAccess(req, res, locationId) {
  if (staffCanAccessLocation(req, locationId)) return true;
  res.status(403).send("You do not have access to this gym's scorecards.");
  return false;
}

function filterRecordingsForStaff(req, recordings) {
  if (req.staff?.is_super) return recordings;
  return (recordings || []).filter((recording) =>
    staffCanAccessLocation(req, recording.location_id),
  );
}

function filterScorecardsForRecordings(scorecards, recordings) {
  const visibleIds = new Set(
    (recordings || []).map((recording) => recording.recording_id),
  );
  return (scorecards || []).filter((scorecard) =>
    visibleIds.has(scorecard.recording_id),
  );
}

function staffTokenQuery(req) {
  return req.staffToken
    ? `staff_token=${encodeURIComponent(req.staffToken)}`
    : "";
}

function withStaffToken(req, href) {
  const tokenQuery = staffTokenQuery(req);
  if (!tokenQuery) return href;
  const sep = href.includes("?") ? "&" : "?";
  return `${href}${sep}${tokenQuery}`;
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
  const resultToken = signRecordingResultToken(recording);
  res.json({
    success: true,
    recording_id: recording.recording_id,
    result_token: resultToken,
    result_url: resultToken
      ? `/recording-result/${encodeURIComponent(recording.recording_id)}`
      : null,
    message: "Audio received",
  });
  processRecording(
    recording.recording_id,
    file.path,
    location_id,
    appointment_id,
  );
});

app.get("/recording-result/:id", async (req, res) => {
  try {
    verifyRecordingResultToken(
      req.query.result_token || req.headers["x-aira-recording-result-token"],
      req.params.id,
    );
    const recording = await db.getRecording(req.params.id);
    if (!recording) {
      return res.status(404).json({ ok: false, error: "Recording not found" });
    }
    const scorecard = await db.getScorecardByRecording(recording.recording_id);
    return res.json({
      ok: true,
      ready: recording.processing_status === "scored" && Boolean(scorecard),
      recording: {
        recording_id: recording.recording_id,
        location_id: recording.location_id,
        contact_name: recording.contact_name,
        duration_seconds: recording.duration_seconds || 0,
        recorded_at: recording.recorded_at,
        processing_status: recording.processing_status,
        transcript: recording.transcript || "",
      },
      scorecard: scorecard ? publicScorecard(scorecard) : null,
    });
  } catch (err) {
    return res.status(401).json({
      ok: false,
      error: "Recording result token is invalid or expired",
    });
  }
});

function publicScorecard(scorecard) {
  return {
    scorecard_id: scorecard.scorecard_id,
    recording_id: scorecard.recording_id,
    total_score: scorecard.total_score,
    sitdown_score: scorecard.sitdown_score,
    objection_score: scorecard.objection_score,
    language_score: scorecard.language_score,
    close_score: scorecard.close_score,
    did_close: scorecard.did_close,
    flagged_for_review: scorecard.flagged_for_review,
    ai_summary: scorecard.ai_summary,
    overall_coaching: scorecard.overall_coaching || scorecard.coaching_note,
    process_warning: scorecard.process_warning,
    created_at: scorecard.created_at,
    categories: [
      {
        key: "sitdown",
        label: "Sit-down",
        score: scorecard.sitdown_score,
        explainer: scorecard.sitdown_score_explainer,
        what_said: scorecard.sitdown_what_said,
        what_to_say: scorecard.sitdown_what_to_say,
        coaching: scorecard.sitdown_coaching,
      },
      {
        key: "objection",
        label: "Objections",
        score: scorecard.objection_score,
        explainer: scorecard.objection_score_explainer,
        what_said: scorecard.objection_what_said,
        what_to_say: scorecard.objection_what_to_say,
        coaching: scorecard.objection_coaching,
      },
      {
        key: "language",
        label: "Language",
        score: scorecard.language_score,
        explainer: scorecard.language_score_explainer,
        what_said: scorecard.language_what_said,
        what_to_say: scorecard.language_what_to_say,
        coaching: scorecard.language_coaching,
      },
      {
        key: "close",
        label: "Close",
        score: scorecard.close_score,
        explainer: scorecard.close_score_explainer,
        what_said: scorecard.close_what_said,
        what_to_say: scorecard.close_what_to_say,
        coaching: scorecard.close_coaching,
      },
    ],
  };
}

async function processRecording(
  recording_id,
  audioFilePath,
  location_id,
  appointment_id,
  testOnly,
) {
  const resolvedLocationId = resolveRecorderLocationId(location_id);
  const location = byLocationId[resolvedLocationId] || {
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
  const token =
    req.query.staff_token ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token && process.env.RECORDER_TOKEN_SECRET) {
    try {
      const payload = verifyStaffToken(token);
      req.staffToken = token;
      req.staff = {
        email: payload.email,
        name: payload.name,
        role: payload.role,
        location_ids: Array.isArray(payload.location_ids)
          ? payload.location_ids.map(normalizeLocationId)
          : [],
        is_super: payload.role === "super_admin",
      };
      return next();
    } catch (err) {
      console.warn("[AdminAuth] staff token rejected:", err.message);
    }
  }

  const password = process.env.ADMIN_PASSWORD || "airafitness";
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
    if (user === "admin" && pass === password) {
      req.staff = {
        email: "admin@local",
        name: "Aira Admin",
        role: "super_admin",
        location_ids: [],
        is_super: true,
      };
      return next();
    }
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
    const recordings = filterRecordingsForStaff(
      req,
      await db.getAllRecordings(),
    );
    const scorecards = filterScorecardsForRecordings(
      await db.getAllScorecards(),
      recordings,
    );
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
      const k = resolveRecorderLocationId(r.location_id) || "unknown";
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
      return `<a href="${withStaffToken(req, `/scorecard/${sc.recording_id}`)}" style="display:inline-block;padding:4px 10px;background:#fff;border:1.5px solid ${color};color:${color};border-radius:9999px;font-size:12px;font-weight:800;text-decoration:none;letter-spacing:.02em;">${score}<span style="color:#9CA3AF;font-weight:600;"> / 100</span></a>`;
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
        const loc =
          byLocationId[resolveRecorderLocationId(r.location_id)] || {};
        const name = r.contact_name || r.appointment_id;
        return `<tr>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#6B7280;white-space:nowrap;">${fmtDate(r.recorded_at)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#111827;font-weight:600;">${loc.franchise_name || r.location_id}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#374151;">${name}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#6B7280;white-space:nowrap;">${fmtDuration(r.duration_seconds)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;">${statusPill(r.processing_status)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;">${scorePill(sc)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;">${r.audio_file_url ? `<a href="${withStaffToken(req, `/playback/${r.recording_id}`)}" style="color:#0284C7;text-decoration:none;font-weight:600;">▶ Play</a>` : '<span style="color:#D1D5DB;">—</span>'}</td>
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
  <div class="subtitle">Live view of all consultation recordings and scoring &nbsp;·&nbsp; <a href="${withStaffToken(req, "/admin/library")}" style="color:#00AEEF;font-weight:700;text-decoration:none;">Training Library →</a> &nbsp;·&nbsp; ${req.staff?.is_super ? `<a href="${withStaffToken(req, "/admin/locations")}" style="color:#00AEEF;font-weight:700;text-decoration:none;">Locations →</a> &nbsp;·&nbsp; ` : ""}<a href="/scoring" style="color:#00AEEF;font-weight:700;text-decoration:none;">How Scoring Works →</a> &nbsp;·&nbsp; <a href="/practice" style="color:#00AEEF;font-weight:700;text-decoration:none;">Practice Bot →</a></div>
</div></div>
<div class="wrap">
  ${rangeSelectorHtml(period.range, withStaffToken(req, "/admin"))}
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
          const href = withStaffToken(
            req,
            `/admin/location/${encodeURIComponent(l.location_id)}?range=${period.range}`,
          );
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
  if (!req.staff?.is_super)
    return res.status(403).send("Owner access required.");
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
  <a href="${withStaffToken(req, "/admin")}" class="back">← Back to Admin</a>

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
      if (!req.staff?.is_super)
        return res.status(403).send("Owner access required.");
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
    if (!req.staff?.is_super)
      return res.status(403).send("Owner access required.");
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
    const slug = resolveRecorderLocationId(req.params.id);
    if (!ensureStaffLocationAccess(req, res, slug)) return;
    const loc = byLocationId[slug] || {
      location_id: slug,
      franchise_name: slug,
    };

    const allRecordings = await db.getAllRecordings();
    const allScorecards = await db.getAllScorecards();

    // Filter to this location (canonicalize each recording to merge historical aliases).
    const recordingsAll = allRecordings.filter(
      (r) => resolveRecorderLocationId(r.location_id) === slug,
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
      return `<a href="${withStaffToken(req, `/scorecard/${sc.recording_id}`)}" style="display:inline-block;padding:4px 10px;background:#fff;border:1.5px solid ${color};color:${color};border-radius:9999px;font-size:12px;font-weight:800;text-decoration:none;letter-spacing:.02em;">${score}<span style="color:#9CA3AF;font-weight:600;"> / 100</span></a>`;
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
        <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;font-size:13px;">${r.audio_file_url ? `<a href="${withStaffToken(req, `/playback/${r.recording_id}`)}" style="color:#0284C7;text-decoration:none;font-weight:600;">▶ Play</a>` : '<span style="color:#D1D5DB;">—</span>'}</td>
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
  <a href="${withStaffToken(req, "/admin")}" class="back">← Back to all locations</a>

  ${rangeSelectorHtml(period.range, withStaffToken(req, `/admin/location/${encodeURIComponent(slug)}`))}
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
    const recordings = filterRecordingsForStaff(
      req,
      await db.getAllRecordings(),
    );
    const scorecards = filterScorecardsForRecordings(
      await db.getAllScorecards(),
      recordings,
    );
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
      const loc =
        byLocationId[resolveRecorderLocationId(rec.location_id)] || {};
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
      return `<a href="${withStaffToken(req, `/scorecard/${h.recording_id}`)}" style="display:block;text-decoration:none;color:inherit;">
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
  <a href="${withStaffToken(req, "/admin")}" class="back">← Back to Admin</a>
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
    const coach_mode =
      req.body.coach_mode === true || req.body.coach_mode === "1";
    const out = startPracticeSession({
      difficulty,
      location_id,
      recently_seen,
      mode,
      player_id,
      player_name,
      forced_scenario_id,
      coach_mode,
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
    const result = await chatAsProspect(session_id, message);
    // Backwards-compatible — game/practice clients reading r.reply still work, coach is optional
    res.json({ ok: true, reply: result.reply, coach: result.coach || null });
  } catch (err) {
    console.error("[Practice] turn error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────── VOICE MODE ───────────
// Mints an OpenAI Realtime ephemeral session keyed to a new practice session. The
// browser then uses that ephemeral key to establish a WebRTC peer connection directly
// to OpenAI for low-latency speech-to-speech with the prospect persona.
app.post("/practice/voice/session", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ ok: false, error: "OPENAI_API_KEY not configured" });
    }
    const difficulty = String(req.body.difficulty || "medium").toLowerCase();
    if (!PROSPECT_PERSONAS[difficulty])
      return res.status(400).json({ ok: false, error: "Invalid difficulty" });
    const location_id = req.body.location_id
      ? canonicalLocationId(req.body.location_id)
      : null;
    const cookieRaw = req.headers.cookie || "";
    const m = cookieRaw.match(/aira_seen=([^;]+)/);
    const recently_seen = m ? decodeURIComponent(m[1]) : "";
    const player_name = req.body.player_name || null;

    // Create the in-memory practice session — same scenario picker as text mode.
    const start = startPracticeSession({
      difficulty,
      location_id,
      recently_seen,
      mode: "practice",
      player_id: null,
      player_name,
      forced_scenario_id: req.body.scenario_id || null,
      coach_mode: false, // voice coach hints come in Milestone 2
    });

    // Look up the full scenario object so we can build the voice instructions.
    const scenario = findScenarioById(start.scenario_id);
    if (!scenario)
      return res
        .status(500)
        .json({ ok: false, error: "Scenario not found after pick" });

    const voice = voiceForPersona(scenario.id);
    const instructions = buildVoiceInstructions(scenario);
    const model = "gpt-realtime";

    // Mint the ephemeral key from OpenAI Realtime GA. The beta /sessions endpoint
    // was retired (Nov 2025); GA uses /client_secrets with a nested session config
    // where voice/transcription/VAD live under audio.input/audio.output.
    const oaResp = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model,
            instructions,
            output_modalities: ["audio"],
            audio: {
              input: {
                transcription: { model: "whisper-1" },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.7,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 900,
                },
              },
              output: { voice },
            },
          },
        }),
      },
    );
    if (!oaResp.ok) {
      const txt = await oaResp.text();
      console.error(
        "[VoicePractice] OpenAI session error:",
        oaResp.status,
        txt,
      );
      return res
        .status(502)
        .json({ ok: false, error: "OpenAI session error: " + txt });
    }
    const data = await oaResp.json();
    const ephemeral_key = data?.value;
    if (!ephemeral_key)
      return res
        .status(502)
        .json({ ok: false, error: "OpenAI did not return an ephemeral key" });

    res.json({
      ok: true,
      session_id: start.session_id,
      scenario_id: start.scenario_id,
      persona_label: start.persona_label,
      persona_name: start.persona_name,
      opening: start.opening,
      ephemeral_key,
      voice,
      model,
    });
  } catch (err) {
    console.error("[VoicePractice] session error:", err.message);
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

    // Voice mode: client posts the full transcript collected from the WebRTC data
    // channel since the in-memory session doesn't see the audio. Overwrite messages
    // before scoring so the scorer reads the actual conversation.
    if (Array.isArray(req.body.messages) && req.body.messages.length > 0) {
      session.messages = req.body.messages
        .filter((m) => m && m.role && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content }));
    }

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

// All scenarios in deterministic order — used to seed today's daily challenge.
const ALL_SCENARIO_IDS = (() => {
  const ids = [];
  for (const k of ["easy", "medium", "hard"]) {
    for (const s of PROSPECT_PERSONAS[k]?.scenarios || []) ids.push(s.id);
  }
  return ids;
})();

// Day-of-year-based daily challenge. Same scenario for everyone on a given day in CT.
function todayDailyChallenge() {
  const ct = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }),
  );
  const start = new Date(ct.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((ct - start) / 86400000);
  const id = ALL_SCENARIO_IDS[dayOfYear % ALL_SCENARIO_IDS.length];
  const sc = findScenarioById(id);
  return sc
    ? {
        scenario_id: id,
        name: sc.name,
        difficulty: sc.difficulty,
        level: sc.level,
        bucket_label: sc.bucket_label,
        opening_preview: sc.opening,
        date_ct: ct.toISOString().slice(0, 10),
      }
    : null;
}

// Achievement definitions. Each unlocks via a function that takes the progress object.
const ACHIEVEMENTS = [
  {
    id: "first_close",
    name: "First Close",
    icon: "🎯",
    description: "Close your first sale.",
    unlock: (p) => p.closes_total >= 1,
  },
  {
    id: "rookie_cleared",
    name: "Out of the Rookie",
    icon: "🚪",
    description: "Clear Level 1.",
    unlock: (p, lvls) => lvls[0].scenarios.some((s) => p.passed_ids.has(s.id)),
  },
  {
    id: "deaf_ear_master",
    name: "Deaf Ear Master",
    icon: "🧠",
    description: "Clear Level 3 (Deaf Ear).",
    unlock: (p, lvls) => lvls[2].scenarios.some((s) => p.passed_ids.has(s.id)),
  },
  {
    id: "negotiator",
    name: "Full-Price Closer",
    icon: "💰",
    description: "Clear Level 4 without ever using the discount.",
    unlock: (p, lvls) => lvls[3].scenarios.some((s) => p.passed_ids.has(s.id)),
  },
  {
    id: "boss_slayer",
    name: "Boss Slayer",
    icon: "👑",
    description: "Clear Level 5 — the toughest closes.",
    unlock: (p, lvls) => lvls[4].scenarios.some((s) => p.passed_ids.has(s.id)),
  },
  {
    id: "perfect_close",
    name: "Perfect Execution",
    icon: "✨",
    description: "Close a sale with a 90+ score.",
    unlock: (p) => p.best_score >= 90,
  },
  {
    id: "streak_3",
    name: "On a Roll",
    icon: "🔥",
    description: "Play 3 days in a row.",
    unlock: (p) => p.streak_current >= 3,
  },
  {
    id: "streak_7",
    name: "Week Warrior",
    icon: "🔥🔥",
    description: "Play 7 days in a row.",
    unlock: (p) => p.streak_current >= 7,
  },
  {
    id: "streak_30",
    name: "Month Maniac",
    icon: "🔥🔥🔥",
    description: "Play 30 days in a row.",
    unlock: (p) => p.streak_current >= 30,
  },
  {
    id: "five_closes",
    name: "Five In",
    icon: "5️⃣",
    description: "Get 5 total closes.",
    unlock: (p) => p.closes_total >= 5,
  },
  {
    id: "twenty_closes",
    name: "Twenty Strong",
    icon: "💪",
    description: "Get 20 total closes.",
    unlock: (p) => p.closes_total >= 20,
  },
  {
    id: "all_levels",
    name: "Game Cleared",
    icon: "🏆",
    description: "Pass at least one scenario in every level.",
    unlock: (p, lvls) =>
      lvls.every((l) => l.scenarios.some((s) => p.passed_ids.has(s.id))),
  },
  {
    id: "completionist",
    name: "Completionist",
    icon: "💯",
    description: "Pass every single scenario.",
    unlock: (p) => p.scenarios_passed_count >= ALL_SCENARIO_IDS.length,
  },
  {
    id: "daily_challenger",
    name: "Daily Challenger",
    icon: "📅",
    description: "Complete today's Daily Challenge.",
    unlock: (p) => p.daily_completed_today === true,
  },
];

app.get("/airafitnessclosinggame/progress", async (req, res) => {
  try {
    const player_id = req.query.player_id;
    if (!player_id)
      return res.status(400).json({ ok: false, error: "player_id required" });

    const [progress, streak, leaderboard] = await Promise.all([
      db.getPlayerGameProgress(player_id),
      db.getPlayerStreak(player_id),
      db.getGameLeaderboard(50),
    ]);

    // Compute leaderboard rank for this player
    const rankIdx = leaderboard.findIndex((r) => r.player_id === player_id);
    const rank = rankIdx >= 0 ? rankIdx + 1 : null;

    // Daily challenge + whether the player's already cleared today's challenge
    const daily = todayDailyChallenge();
    const ctToday = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }),
    );
    ctToday.setHours(0, 0, 0, 0);
    const dailyCompletedToday = (progress.per_scenario || []).some((s) => {
      if (s.scenario_id !== daily?.scenario_id) return false;
      // Was it passed AND played today CT?
      // (The progress fn doesn't return per-row dates; we rely on best_score+passed for today.)
      // For simplicity: if the scenario is in passed list AND was attempted today, count it.
      return s.passed === true; // close enough for v1 — refine if needed
    });

    // Achievements — pass a flat shape into the unlock fns
    const passedIds = new Set(
      (progress.per_scenario || [])
        .filter((s) => s.passed)
        .map((s) => s.scenario_id),
    );
    const bestScore = (progress.per_scenario || []).reduce(
      (m, s) => Math.max(m, s.best_score || 0),
      0,
    );
    const ctx = {
      ...progress,
      passed_ids: passedIds,
      scenarios_passed_count: passedIds.size,
      best_score: bestScore,
      streak_current: streak.current,
      daily_completed_today: dailyCompletedToday,
    };
    const achievements = ACHIEVEMENTS.map((a) => ({
      id: a.id,
      name: a.name,
      icon: a.icon,
      description: a.description,
      unlocked: !!a.unlock(ctx, GAME_LEVELS),
    }));

    res.json({
      ok: true,
      progress,
      levels: GAME_LEVELS,
      streak,
      rank,
      leaderboard_top: leaderboard.slice(0, 10),
      daily,
      daily_completed_today: dailyCompletedToday,
      achievements,
    });
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
body.embed-mode .header{display:none;}
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
.header-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end;}
.practice-link{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;background:rgba(0,174,239,0.08);border:1px solid rgba(0,174,239,0.3);border-radius:999px;color:#22D3EE;font-size:12px;font-weight:700;text-decoration:none;letter-spacing:.04em;transition:all .15s;}
.practice-link:hover{background:rgba(0,174,239,0.15);border-color:rgba(0,174,239,0.6);transform:translateY(-1px);}
.player-pill{display:flex;align-items:center;gap:10px;padding:8px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:999px;font-size:12px;color:#9CA3AF;}
.player-pill .xp{color:#00AEEF;font-weight:900;}
.player-pill .name{color:#fff;font-weight:700;}

/* Practice card on level map — opens /practice in a new tab, no game progress affected */
.practice-card{
  display:flex;align-items:center;gap:18px;
  background:linear-gradient(135deg,rgba(0,174,239,0.08),rgba(124,58,237,0.06));
  border:1px solid rgba(0,174,239,0.25);
  border-radius:16px;
  padding:20px 24px;margin-bottom:24px;
  text-decoration:none;color:inherit;
  transition:all .2s;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
}
.practice-card:hover{border-color:rgba(0,174,239,0.55);transform:translateY(-2px);box-shadow:0 8px 28px rgba(0,174,239,0.15);}
.practice-icon{font-size:32px;flex-shrink:0;line-height:1;}
.practice-body{flex:1;min-width:0;}
.practice-title{font-size:18px;font-weight:900;color:#fff;letter-spacing:-.01em;margin-bottom:6px;}
.practice-arrow{display:inline-block;color:#22D3EE;transition:transform .2s;margin-left:4px;}
.practice-card:hover .practice-arrow{transform:translateX(4px);}
.practice-sub{font-size:13px;color:#9CA3AF;line-height:1.55;}
.practice-sub b{color:#22D3EE;font-weight:700;}

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
.stat-sub{font-size:11px;color:#FBBF24;font-weight:700;margin-top:4px;letter-spacing:.04em;}

/* Daily challenge card */
.daily-banner{
  background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,255,255,0.1);
  border-left:4px solid var(--dc-color,#FBBF24);
  border-radius:16px;
  padding:22px 26px;
  margin-bottom:24px;
  position:relative;overflow:hidden;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
}
.daily-banner::before{
  content:'';position:absolute;top:-50%;right:-20%;width:60%;height:200%;
  background:radial-gradient(ellipse, var(--dc-color,#FBBF24) 0%, transparent 60%);
  opacity:.18;filter:blur(40px);pointer-events:none;
}
.daily-flag{font-size:11px;font-weight:900;letter-spacing:.18em;color:#FBBF24;text-transform:uppercase;margin-bottom:8px;position:relative;}
.daily-title{font-size:24px;font-weight:900;color:#fff;margin-bottom:6px;letter-spacing:-.02em;position:relative;}
.daily-sub{font-size:13px;color:#9CA3AF;margin-bottom:16px;line-height:1.55;max-width:580px;position:relative;}
.daily-done{display:inline-block;padding:8px 18px;background:rgba(34,211,238,0.15);color:#22D3EE;border:1px solid rgba(34,211,238,0.3);border-radius:9999px;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;position:relative;}
.daily-btn{position:relative;display:inline-block;width:auto;padding:12px 24px;}

/* Grading explainer card */
.grading-card{
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(255,255,255,0.08);
  border-radius:16px;
  padding:24px 26px;
  margin-bottom:28px;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
}
.grading-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;flex-wrap:wrap;gap:12px;padding-bottom:16px;border-bottom:1px solid rgba(255,255,255,0.06);}
.grading-eyebrow{font-size:11px;font-weight:900;letter-spacing:.18em;color:#00AEEF;text-transform:uppercase;}
.grading-sub{font-size:13px;color:#9CA3AF;margin-top:4px;line-height:1.5;}
.grading-deep{font-size:12px;font-weight:700;color:#00AEEF;text-decoration:none;letter-spacing:.04em;flex-shrink:0;padding:6px 12px;border:1px solid rgba(0,174,239,0.3);border-radius:9999px;transition:all .15s;}
.grading-deep:hover{background:rgba(0,174,239,0.08);border-color:rgba(0,174,239,0.6);}
.grading-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:20px;}
.grading-cat{padding:14px 16px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;}
.grading-cat-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;gap:8px;}
.grading-cat-name{font-size:13px;font-weight:800;color:#fff;letter-spacing:-.005em;}
.grading-cat-pts{font-size:11px;font-weight:800;color:#00AEEF;letter-spacing:.04em;flex-shrink:0;}
.grading-cat-desc{font-size:12.5px;color:#9CA3AF;line-height:1.55;}
.grading-thresh{display:flex;flex-direction:column;gap:8px;padding:14px 16px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;margin-bottom:14px;}
.grading-thresh-row{display:flex;align-items:center;gap:14px;}
.grading-thresh-num{font-size:14px;font-weight:900;letter-spacing:-.02em;width:62px;flex-shrink:0;}
.grading-thresh-num.t-good{color:#22D3EE;}
.grading-thresh-num.t-mid{color:#0284C7;}
.grading-thresh-num.t-low{color:#EC4899;}
.grading-thresh-text{font-size:13px;color:#D1D5DB;}
.grading-foot{font-size:13px;color:#9CA3AF;text-align:center;padding:12px 0 2px;line-height:1.55;}
.grading-foot b{color:#fff;font-weight:800;}

/* Achievements grid */
.achievement-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:8px;}
.ach{
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(255,255,255,0.08);
  border-radius:12px;
  padding:16px 14px;
  text-align:center;
  transition:transform .2s,border-color .2s;
}
.ach.unlocked{border-color:rgba(0,174,239,0.35);background:rgba(0,174,239,0.06);}
.ach.unlocked:hover{transform:translateY(-3px);border-color:rgba(0,174,239,0.6);}
.ach.locked{opacity:.45;}
.ach-icon{font-size:32px;line-height:1;margin-bottom:8px;}
.ach-name{font-size:12px;font-weight:800;color:#fff;letter-spacing:-.005em;margin-bottom:4px;}
.ach.locked .ach-name{color:#9CA3AF;}
.ach-desc{font-size:11px;color:#9CA3AF;line-height:1.4;}

/* Leaderboard list */
.leaderboard-list{display:flex;flex-direction:column;gap:6px;margin-bottom:32px;}
.lb-row{
  display:flex;align-items:center;gap:14px;
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(255,255,255,0.08);
  border-radius:10px;
  padding:12px 16px;
}
.lb-row.you{border-color:rgba(0,174,239,0.5);background:rgba(0,174,239,0.08);}
.lb-rank{
  width:32px;height:32px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font-weight:900;font-size:13px;flex-shrink:0;
}
.lb-name{flex:1;font-size:14px;font-weight:700;color:#fff;display:flex;align-items:center;gap:8px;}
.lb-you{display:inline-block;padding:2px 8px;background:#00AEEF;color:#0A0A0A;border-radius:9999px;font-size:9px;font-weight:900;letter-spacing:.1em;}
.lb-xp{font-weight:900;color:#fff;font-size:16px;letter-spacing:-.01em;}

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

/* Scene-setter card */
.scene-set{align-self:stretch;max-width:100%;background:linear-gradient(135deg,rgba(0,174,239,0.06),rgba(124,58,237,0.06));border:1px solid rgba(0,174,239,0.25);border-left:4px solid #00AEEF;border-radius:12px;padding:16px 18px;margin-bottom:6px;animation:fadeIn .25s ease-out;}
.scene-eyebrow{font-size:10px;font-weight:800;letter-spacing:.14em;color:#22D3EE;text-transform:uppercase;margin-bottom:6px;}
.scene-title{font-size:16px;font-weight:800;color:#fff;letter-spacing:-.005em;margin-bottom:6px;}
.scene-body{font-size:13.5px;color:#D1D5DB;line-height:1.6;}
.scene-body b{color:#fff;font-weight:700;}

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
      <div class="header-right">
        <a href="/practice" target="_blank" class="practice-link">💪 Practice Mode</a>
        <div id="player-pill" class="player-pill hidden">
          <span class="name" id="pp-name">Player</span> · <span class="xp"><span id="pp-xp">0</span> XP</span>
        </div>
      </div>
    </div>

    <!-- SPLASH -->
    <div id="splash" class="splash">
      <h1>Become an Expert Closer</h1>
      <p class="tag">Five levels. Eleven prospects. Every objection you'll hear on the floor — simulated, scored, and coached. Beat each level to unlock the next. <b>Let's see how good you really are.</b><br><br><a href="/scoring" target="_blank" style="color:#00AEEF;font-weight:700;text-decoration:none;font-size:13px;letter-spacing:.04em;">How scoring works →</a></p>
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
        <div class="stat-card"><div class="stat-label">🔥 Streak</div><div class="stat-num" id="stat-streak">0</div><div class="stat-sub" id="stat-streak-sub"></div></div>
        <div class="stat-card"><div class="stat-label">Closes</div><div class="stat-num" id="stat-closes">0</div></div>
        <div class="stat-card"><div class="stat-label">Rank</div><div class="stat-num" id="stat-rank">—</div></div>
      </div>

      <div id="daily-card" class="hidden"></div>

      <a href="/practice" target="_blank" class="practice-card">
        <div class="practice-icon">💪</div>
        <div class="practice-body">
          <div class="practice-title">Just want to practice? <span class="practice-arrow">→</span></div>
          <div class="practice-sub">Open Practice Mode in a new tab. Run mock consults without affecting your game progress. Includes <b>Coached Mode</b> — real-time hints + suggested wording when you go off-script. Best for new reps still learning.</div>
        </div>
      </a>

      <div class="grading-card">
        <div class="grading-head">
          <div>
            <div class="grading-eyebrow">How You're Graded</div>
            <div class="grading-sub">100 points total — every consult is scored on these four categories</div>
          </div>
          <a href="/scoring" target="_blank" class="grading-deep">Full breakdown →</a>
        </div>
        <div class="grading-grid">
          <div class="grading-cat">
            <div class="grading-cat-head"><span class="grading-cat-name">Sit-Down Presentation</span><span class="grading-cat-pts">25 pts</span></div>
            <div class="grading-cat-desc">Did you nail the opening — month-to-month, no contracts, first + last + enrollment, "like every other gym," ending with "Make sense?" All three tiers presented. Stay seated.</div>
          </div>
          <div class="grading-cat">
            <div class="grading-cat-head"><span class="grading-cat-name">Objection Handling</span><span class="grading-cat-pts">25 pts</span></div>
            <div class="grading-cat-desc">Did you run the Deaf Ear Close on the first objection before offering anything? Did you isolate cost before pulling out the Coupon Drop? Payment-timing before the Google Review Drop?</div>
          </div>
          <div class="grading-cat">
            <div class="grading-cat-head"><span class="grading-cat-name">Language &amp; Psychology</span><span class="grading-cat-pts">25 pts</span></div>
            <div class="grading-cat-desc">Did you use assumptive language ("Which one would you like to get started with today?") and strategic questions whose answer was already a yes? No true permission-seeking, no hedge phrases.</div>
          </div>
          <div class="grading-cat">
            <div class="grading-cat-head"><span class="grading-cat-name">Close Execution</span><span class="grading-cat-pts">25 pts</span></div>
            <div class="grading-cat-desc">Assumptive close, immediate ID collection without a hedge, and the post-close moves that build the business — PIF offer + referral collection.</div>
          </div>
        </div>
        <div class="grading-thresh">
          <div class="grading-thresh-row"><span class="grading-thresh-num t-good">85+</span><span class="grading-thresh-text">Excellence — you've internalized the psychology</span></div>
          <div class="grading-thresh-row"><span class="grading-thresh-num t-mid">70–84</span><span class="grading-thresh-text">Solid — passing. Coaching note will name 1–2 refinements</span></div>
          <div class="grading-thresh-row"><span class="grading-thresh-num t-low">&lt;70</span><span class="grading-thresh-text">Needs work — structural moves missing. Auto-flagged for review</span></div>
        </div>
        <div class="grading-foot">To clear a scenario in this game: <b>close the sale AND score 70+.</b></div>
      </div>

      <div class="level-grid" id="level-grid"></div>

      <div class="map-head" style="margin-top:36px;"><h2 style="font-size:24px;">Achievements</h2><p>Collect them all.</p></div>
      <div class="achievement-grid" id="achievement-grid"></div>

      <div class="map-head" style="margin-top:36px;"><h2 style="font-size:24px;">Top Closers</h2><p id="lb-sub">All-time leaderboard.</p></div>
      <div class="leaderboard-list" id="leaderboard-list"></div>
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
const QUERY_PARAMS = new URLSearchParams(window.location.search);
function applyEmbedMode(){
  if (QUERY_PARAMS.get('embed') === '1') document.body.classList.add('embed-mode');
}
function ensureLocationOption(location_id, label){
  if (!location_id) return;
  const select = $('location');
  if (!select) return;
  const exists = Array.from(select.options).some(opt => opt.value === location_id);
  if (!exists) {
    const option = document.createElement('option');
    option.value = location_id;
    option.textContent = label || 'Assigned gym';
    select.appendChild(option);
  }
}
function applyQueryLocations(){
  const raw = QUERY_PARAMS.get('locations');
  if (!raw) return;
  let locations = [];
  try {
    locations = JSON.parse(raw);
  } catch (err) {
    console.warn('[Embed] Could not parse locations query param', err);
    return;
  }
  if (!Array.isArray(locations) || !locations.length) return;
  const select = $('location');
  if (!select) return;
  select.innerHTML = '<option value="">— Select your gym —</option>';
  locations
    .filter(loc => loc && loc.id)
    .forEach(loc => {
      const option = document.createElement('option');
      option.value = loc.id;
      option.textContent = loc.name || loc.id;
      select.appendChild(option);
    });
}
function loadCachedProfile(){
  const e = (document.cookie.match(/aira_player_email=([^;]+)/)||[])[1];
  const n = (document.cookie.match(/aira_player_name=([^;]+)/)||[])[1];
  const l = (document.cookie.match(/aira_player_location=([^;]+)/)||[])[1];
  if (e) PLAYER.email = decodeURIComponent(e);
  if (n) PLAYER.name = decodeURIComponent(n);
  if (l) PLAYER.location_id = decodeURIComponent(l);
}
function loadQueryProfile(){
  const email = (QUERY_PARAMS.get('email') || '').trim();
  const name = (QUERY_PARAMS.get('name') || '').trim();
  const location_id = (QUERY_PARAMS.get('location_id') || '').trim();
  const location_name = (QUERY_PARAMS.get('location_name') || '').trim();
  if (email) PLAYER.email = email;
  if (name) PLAYER.name = name;
  if (location_id) {
    PLAYER.location_id = location_id;
    ensureLocationOption(location_id, location_name);
  }
  return !!email;
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
    PLAYER.streak = d.streak || { current: 0, longest: 0 };
    PLAYER.rank = d.rank;
    PLAYER.daily = d.daily;
    PLAYER.daily_done = d.daily_completed_today;
    PLAYER.achievements = d.achievements || [];
    PLAYER.leaderboard_top = d.leaderboard_top || [];
    refreshHeader();
    renderDaily();
    renderAchievements();
    renderLeaderboard();
  } catch (e) { console.error('progress fetch failed', e); }
}

function renderDaily(){
  const el = $('daily-card');
  if (!PLAYER.daily) { el.classList.add('hidden'); return; }
  const sc = PLAYER.daily;
  const done = PLAYER.daily_done;
  const lvl = LEVELS.find(l => l.scenarios.some(x => x.id === sc.scenario_id));
  const color = lvl ? lvl.color : '#00AEEF';
  const fullScenario = lvl ? lvl.scenarios.find(x => x.id === sc.scenario_id) : null;
  el.classList.remove('hidden');
  el.innerHTML =
    '<div class="daily-banner" style="--dc-color:' + color + ';">' +
      '<div class="daily-flag">⚡ TODAY\\'S CHALLENGE · 1.5× XP</div>' +
      '<div class="daily-title">' + sc.name + '</div>' +
      '<div class="daily-sub">' + (lvl ? 'Level ' + lvl.level + ' · ' + lvl.name : sc.bucket_label) + ' · One new prospect every day. Come back tomorrow for a fresh one.</div>' +
      (done
        ? '<div class="daily-done">✓ COMPLETED TODAY</div>'
        : (fullScenario && lvl
            ? '<button class="btn-primary daily-btn" onclick="startSession(LEVELS[' + (lvl.level - 1) + '].scenarios.find(s => s.id === \\'' + sc.scenario_id + '\\'), LEVELS[' + (lvl.level - 1) + '])">Take the Challenge →</button>'
            : '')) +
    '</div>';
}

function renderAchievements(){
  const grid = $('achievement-grid');
  if (!grid) return;
  grid.innerHTML = (PLAYER.achievements || []).map(a => {
    const cls = a.unlocked ? 'unlocked' : 'locked';
    return '<div class="ach ' + cls + '" title="' + a.description.replace(/"/g, '&quot;') + '">' +
      '<div class="ach-icon">' + (a.unlocked ? a.icon : '🔒') + '</div>' +
      '<div class="ach-name">' + a.name + '</div>' +
      '<div class="ach-desc">' + (a.unlocked ? a.description : '???') + '</div>' +
    '</div>';
  }).join('');
}

function renderLeaderboard(){
  const list = $('leaderboard-list');
  if (!list) return;
  const top = PLAYER.leaderboard_top || [];
  if (top.length === 0) { list.innerHTML = '<div style="color:#9CA3AF;font-size:13px;text-align:center;padding:20px;">No one has scored yet — be the first.</div>'; return; }
  list.innerHTML = top.map((row, i) => {
    const isYou = row.player_id === PLAYER.id;
    const rankBg = i === 0 ? 'linear-gradient(135deg,#FBBF24,#F59E0B)' : i === 1 ? 'linear-gradient(135deg,#E5E7EB,#9CA3AF)' : i === 2 ? 'linear-gradient(135deg,#D97706,#92400E)' : 'rgba(255,255,255,0.06)';
    const rankColor = i < 3 ? '#0A0A0A' : '#fff';
    return '<div class="lb-row' + (isYou ? ' you' : '') + '">' +
      '<div class="lb-rank" style="background:' + rankBg + ';color:' + rankColor + ';">' + (i + 1) + '</div>' +
      '<div class="lb-name">' + (row.player_name || 'Player') + (isYou ? ' <span class="lb-you">YOU</span>' : '') + '</div>' +
      '<div class="lb-xp">' + row.total_xp + ' <span style="color:#9CA3AF;font-weight:600;font-size:11px;">XP</span></div>' +
    '</div>';
  }).join('');
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
  const sCur = (PLAYER.streak && PLAYER.streak.current) || 0;
  const sLong = (PLAYER.streak && PLAYER.streak.longest) || 0;
  $('stat-streak').textContent = sCur;
  $('stat-streak-sub').textContent = sLong > sCur ? 'best ' + sLong : (sCur >= 3 ? 'keep it going!' : '');
  $('stat-rank').textContent = PLAYER.rank ? '#' + PLAYER.rank : '—';
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
  sceneSet(sc.name);
  bubble('prospect', r.opening);
  $('rep-input').focus();
}

function sceneSet(name){
  const div = document.createElement('div');
  div.className = 'scene-set';
  div.innerHTML =
    '<div class="scene-eyebrow">📍 Scene</div>' +
    '<div class="scene-title">You just finished the tour.</div>' +
    '<div class="scene-body">' + name + ' is sitting at your desk waiting to hear about pricing. Your next move: <b>start the price presentation and go over the programs offered.</b></div>';
  $('messages').appendChild(div);
  $('messages').scrollTop = $('messages').scrollHeight;
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
  if ($('end-btn').disabled) return;
  $('end-btn').disabled = true;
  $('end-btn').textContent = 'Scoring…';
  $('chat').classList.add('hidden');
  $('score').classList.remove('hidden');
  $('score').innerHTML = '<div class="celebration"><h2>Scoring…</h2><p class="sub">Analyzing your full conversation. This takes 20-40 seconds — don\\'t close the tab.</p><div class="spinner-row"><div class="spinner"></div><div style="color:#9CA3AF;font-size:13px;">Reading every move you made…</div></div></div>';
  try {
    const r = await postJson('/practice/end', { session_id: SESSION_ID });
    if (!r.ok){
      // Show error WITH a "back to consult" option so the user can keep going
      const goBack = SESSION_ID ? '<button class="btn-secondary" onclick="resumeChat()">← Back to consult</button> ' : '';
      $('score').innerHTML = '<div class="celebration fail"><h2>Couldn\\'t score yet</h2><p class="sub">'+r.error+'</p><div class="btn-row" style="justify-content:center;">'+goBack+'<button class="btn-secondary" onclick="showMap()">Back to Levels</button></div></div>';
      $('end-btn').disabled = false;
      $('end-btn').textContent = 'End & Score';
      return;
    }
    await fetchProgress();
    renderResult(r.scorecard, r.messages);
  } catch (err) {
    $('score').innerHTML = '<div class="celebration fail"><h2>Connection Error</h2><p class="sub">Couldn\\'t reach the scorer. '+(err.message||err)+'</p><div class="btn-row" style="justify-content:center;"><button class="btn-secondary" onclick="resumeChat()">← Back to consult</button> <button class="btn-secondary" onclick="$(\\'end-btn\\').click()">Try scoring again</button></div></div>';
    $('end-btn').disabled = false;
    $('end-btn').textContent = 'End & Score';
  }
};

function resumeChat(){
  $('score').classList.add('hidden');
  $('chat').classList.remove('hidden');
  $('end-btn').disabled = false;
  $('end-btn').textContent = 'End & Score';
  $('rep-input').focus();
}

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
applyEmbedMode();
applyQueryLocations();
loadCachedProfile();
const hasQueryIdentity = loadQueryProfile();
const cookiePlayerId = getCookiePlayerId();
if (PLAYER.email) $('player-email').value = PLAYER.email;
if (PLAYER.name) $('player-name').value = PLAYER.name;
if (PLAYER.location_id) {
  ensureLocationOption(PLAYER.location_id);
  $('location').value = PLAYER.location_id;
}
if (hasQueryIdentity){
  $('enter-btn').disabled = true;
  $('enter-btn').textContent = 'Loading…';
  PLAYER.name = PLAYER.name || 'Player';
  identifyPlayer(PLAYER.email, PLAYER.name, PLAYER.location_id)
    .then(() => {
      saveProfile();
      return fetchProgress();
    })
    .then(showMap)
    .catch(err => {
      console.error('[Game] portal identity failed', err);
      $('enter-btn').disabled = false;
      $('enter-btn').textContent = 'Enter the Game →';
    });
} else if (PLAYER.email && cookiePlayerId){
  // Returning player — restore the form values, set the canonical id, and fetch progress.
  PLAYER.id = cookiePlayerId;
  fetchProgress().then(()=>{
    if (PLAYER.attempts > 0) showMap(); // skip splash, go straight to level map
  });
}
</script>
</body></html>`);
});

// ─────────── /scoring — public explainer for franchisees + VPs ───────────
app.get("/scoring", (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>How You're Graded · Aira Fitness</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%;}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Arial,sans-serif;
  background:#05080F;color:#E5E7EB;-webkit-font-smoothing:antialiased;
  position:relative;min-height:100vh;overflow-x:hidden;line-height:1.55;
}
body::before{
  content:'';position:fixed;inset:-50%;
  background:
    radial-gradient(ellipse 60% 40% at 20% 20%, rgba(0,174,239,0.18), transparent 60%),
    radial-gradient(ellipse 50% 50% at 80% 30%, rgba(124,58,237,0.14), transparent 60%),
    radial-gradient(ellipse 70% 50% at 50% 90%, rgba(236,72,153,0.10), transparent 60%);
  filter:blur(40px);z-index:0;animation:auroraShift 22s ease-in-out infinite alternate;
}
@keyframes auroraShift{0%{transform:translate(0,0) rotate(0);}100%{transform:translate(-3%,3%) rotate(2deg);}}
body::after{
  content:'';position:fixed;inset:0;z-index:0;pointer-events:none;opacity:0.6;
  background-image:
    radial-gradient(1px 1px at 12% 18%, rgba(255,255,255,0.4), transparent),
    radial-gradient(1px 1px at 47% 73%, rgba(0,174,239,0.5), transparent),
    radial-gradient(1px 1px at 82% 27%, rgba(255,255,255,0.3), transparent),
    radial-gradient(1px 1px at 33% 88%, rgba(124,58,237,0.4), transparent),
    radial-gradient(2px 2px at 15% 65%, rgba(0,174,239,0.55), transparent);
}
@keyframes slideUp{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:translateY(0);}}
@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}

.app{position:relative;z-index:1;min-height:100vh;padding:24px;}
.shell{max-width:920px;margin:0 auto;}

/* HEADER */
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:36px;flex-wrap:wrap;gap:12px;}
.logo{font-size:18px;font-weight:900;letter-spacing:.2em;}
.logo .b{color:#00AEEF;text-shadow:0 0 24px rgba(0,174,239,.55);}
.logo .w{color:#fff;}
.logo .badge{display:inline-block;margin-left:14px;padding:4px 12px;background:linear-gradient(135deg,#00AEEF,#7C3AED);color:#fff;border-radius:999px;font-size:11px;letter-spacing:.16em;text-shadow:none;font-weight:800;}
.header-right{display:flex;gap:8px;flex-wrap:wrap;}
.header-link{display:inline-flex;align-items:center;padding:7px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#9CA3AF;border-radius:999px;font-size:12px;font-weight:700;text-decoration:none;letter-spacing:.04em;transition:all .15s;}
.header-link:hover{border-color:rgba(0,174,239,0.4);color:#22D3EE;}
.header-link.cta{background:rgba(0,174,239,0.08);border-color:rgba(0,174,239,0.3);color:#22D3EE;}

/* HERO */
.hero{text-align:center;padding:20px 0 48px;animation:slideUp .8s ease-out;}
.hero .eyebrow{font-size:11px;font-weight:900;color:#22D3EE;letter-spacing:.18em;text-transform:uppercase;margin-bottom:12px;}
.hero h1{
  font-size:clamp(38px,6vw,68px);font-weight:900;line-height:1;letter-spacing:-.02em;
  background:linear-gradient(120deg,#00AEEF 0%,#7C3AED 50%,#EC4899 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  margin-bottom:18px;filter:drop-shadow(0 4px 24px rgba(0,174,239,.3));
}
.hero .lede{font-size:16px;color:#9CA3AF;max-width:600px;margin:0 auto;line-height:1.65;}
.hero .lede b{color:#fff;font-weight:600;}

/* INTRO CARD */
.card{
  background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);
  border-radius:16px;padding:24px 28px;margin-bottom:18px;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  animation:fadeIn .8s ease-out;
}
.intro{border-left:4px solid #00AEEF;font-size:15px;color:#E5E7EB;line-height:1.7;}
.intro b{color:#fff;}

h2.section{font-size:28px;font-weight:900;color:#fff;letter-spacing:-.02em;margin:40px 0 16px;}
h2.section .accent{
  background:linear-gradient(120deg,#22D3EE,#7C3AED);
  -webkit-background-clip:text;background-clip:text;color:transparent;
}

/* CATEGORY CARDS */
.cat{
  background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);
  border-radius:16px;padding:26px 28px;margin-bottom:14px;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  position:relative;overflow:hidden;
}
.cat::before{
  content:'';position:absolute;top:0;left:0;right:0;height:3px;
  background:linear-gradient(90deg,var(--cat-color,#00AEEF),transparent);
}
.cat-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid rgba(255,255,255,0.06);flex-wrap:wrap;gap:8px;}
.cat-name{font-size:22px;font-weight:900;color:#fff;letter-spacing:-.01em;}
.cat-pts{font-size:12px;font-weight:800;color:var(--cat-color,#00AEEF);letter-spacing:.06em;text-transform:uppercase;}
.cat p{margin-bottom:14px;color:#9CA3AF;font-size:14.5px;line-height:1.7;}
.cat .what-it-tests{font-size:10px;font-weight:800;color:#9CA3AF;text-transform:uppercase;letter-spacing:.16em;margin-bottom:6px;}
.cat ul{padding-left:0;list-style:none;margin:14px 0;}
.cat li{padding:9px 0 9px 28px;position:relative;font-size:14px;color:#D1D5DB;line-height:1.6;}
.cat li.good::before{content:"✓";position:absolute;left:0;top:9px;color:#22D3EE;font-weight:900;font-size:14px;}
.cat li.bad::before{content:"✗";position:absolute;left:0;top:9px;color:#EC4899;font-weight:900;font-size:14px;}
.cat li b{color:#fff;font-weight:700;}
.cat .example{
  background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.06);border-left:3px solid var(--cat-color,#00AEEF);
  padding:14px 18px;margin:14px 0 6px;border-radius:8px;
  font-size:13.5px;color:#D1D5DB;font-style:italic;line-height:1.65;
}
.cat .example b{color:var(--cat-color,#00AEEF);font-style:normal;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;display:block;margin-bottom:6px;}

/* THRESHOLDS */
.thresholds{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:18px 0;}
.thresh{
  padding:22px 22px;border-radius:14px;
  background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  position:relative;overflow:hidden;
}
.thresh.t85{border-color:rgba(34,211,238,0.4);box-shadow:0 0 0 1px rgba(34,211,238,0.15),0 8px 24px rgba(34,211,238,0.08);}
.thresh.t70{border-color:rgba(2,132,199,0.4);}
.thresh.tlow{border-color:rgba(236,72,153,0.4);}
.thresh-num{font-size:34px;font-weight:900;letter-spacing:-.03em;line-height:1;}
.thresh.t85 .thresh-num{background:linear-gradient(120deg,#22D3EE,#00AEEF);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 0 24px rgba(34,211,238,.4);}
.thresh.t70 .thresh-num{color:#0284C7;}
.thresh.tlow .thresh-num{color:#EC4899;}
.thresh-label{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;margin-top:8px;color:#fff;}
.thresh-desc{font-size:13px;color:#9CA3AF;margin-top:8px;line-height:1.55;}

/* CALLOUT */
.callout{
  background:linear-gradient(135deg,rgba(0,174,239,0.06),rgba(124,58,237,0.06));
  border:1px solid rgba(0,174,239,0.25);border-left:4px solid #00AEEF;
  border-radius:14px;padding:22px 26px;margin:18px 0;
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
}
.callout-head{font-size:11px;font-weight:800;color:#22D3EE;text-transform:uppercase;letter-spacing:.14em;margin-bottom:10px;}
.callout p{font-size:14.5px;color:#D1D5DB;line-height:1.7;}
.callout p + p{margin-top:10px;}
.callout b{color:#fff;}
.cat .callout{margin:18px 0 4px;border-left-color:#FBBF24;background:rgba(251,191,36,0.04);border-color:rgba(251,191,36,0.25);}
.cat .callout-head{color:#FBBF24;}

.cat .closing-def{margin-top:6px;}
.cat .closing-def b{color:#fff;}
.cat .closing-def-sub{color:#9CA3AF;font-size:13.5px;margin-top:8px;}

.outro{text-align:center;color:#9CA3AF;font-size:13px;margin-top:36px;padding:20px 0;}
.outro a{color:#22D3EE;font-weight:700;text-decoration:none;}
.outro a:hover{color:#00AEEF;}
</style></head><body>

<div class="app"><div class="shell">

  <div class="header">
    <div class="logo"><span class="b">AIRA</span><span class="w">FITNESS</span><span class="badge">THE RUBRIC</span></div>
    <div class="header-right">
      <a href="/practice" target="_blank" class="header-link cta">💪 Practice Bot</a>
      <a href="/airafitnessclosinggame" target="_blank" class="header-link cta">🎮 Closing Game</a>
    </div>
  </div>

  <div class="hero">
    <div class="eyebrow">How You're Graded</div>
    <h1>Every Word Scored.</h1>
    <p class="lede">Real consults and practice runs use the <b>same scoring brain</b>. Here's exactly what we look for, what gets full marks, and what costs you points.</p>
  </div>

  <div class="card intro">
    <b>Total possible: 100 points.</b> Four categories, each worth 25 points. The score is a coaching tool, not a test — it tells you what to sharpen for the next consult, not whether you "passed." <b>Closing the sale is the goal.</b> The score helps you build the habits that close more sales, more often, on harder prospects.
  </div>

  <h2 class="section">The Four <span class="accent">Categories</span></h2>

  <div class="cat" style="--cat-color:#22D3EE;">
    <div class="cat-head"><div class="cat-name">Sit-Down Presentation</div><div class="cat-pts">25 pts</div></div>
    <div class="what-it-tests">What it tests</div>
    <p>How you present pricing once the prospect is seated at the desk. The opening sentence sets the entire emotional tone of the close.</p>
    <ul>
      <li class="good"><b>The five components of the sit-down:</b> "month to month," "no contracts / cancel anytime," "first + last + enrollment fee," "like every other gym," and ending with <b>"Make sense?"</b></li>
      <li class="good">All three tiers presented with a brief description of what each one includes</li>
      <li class="good">Price sheet stays face-down until the sit-down completes</li>
      <li class="good">You stay seated for the entire close (never close while standing)</li>
      <li class="good">Use of the assumptive close: <b>"Which one would you like to get started with today?"</b></li>
      <li class="bad">Naming a price before doing the sit-down — sends the prospect into price-defense mode</li>
      <li class="bad">Skipping <b>"Make sense?"</b> — that micro-yes is what primes every downstream yes</li>
    </ul>
    <div class="example"><b>Full credit example</b>"At our gym we are month to month — there are no contracts, you can cancel any time. You just pay your first month, last month, and a one-time enrollment fee like every other gym. Make sense?"</div>
  </div>

  <div class="cat" style="--cat-color:#0284C7;">
    <div class="cat-head"><div class="cat-name">Objection Handling</div><div class="cat-pts">25 pts</div></div>
    <div class="what-it-tests">What it tests</div>
    <p>How you respond when the prospect pushes back. The Aira approach uses a specific sequence — diagnose the real objection before offering any solution.</p>
    <ul>
      <li class="good"><b>The Deaf Ear Close on the FIRST objection</b> before any offer: "I totally understand. Did you like the gym? Does it have everything you need? Is it more about the upfront costs that's stopping you from joining today?"</li>
      <li class="good">Isolating the real objection with a question, not an assumption</li>
      <li class="good"><b>Coupon Drop only after cost is confirmed</b> — "Did you happen to get our coupon mailer? It discounted the enrollment 50%. Would that help?"</li>
      <li class="good"><b>Payment-timing solution before the Google Review Drop</b> when the objection is timing-based ("I get paid Friday"). Post-dating the billing closes at full price — that's a better outcome than waiving the enrollment.</li>
      <li class="good">Google Review Drop only as last resort, after both Coupon and payment-timing have been declined</li>
      <li class="good">For a spouse / girlfriend / partner objection: Deaf Ear → "If your partner doesn't join, would you still be interested?" → free pass on your account for them</li>
      <li class="bad">Leading with a discount before isolating cost — destroys leverage you didn't need to spend</li>
      <li class="bad">Using the Google Review Drop too early — it's the most expensive lever, save it</li>
      <li class="bad">Accepting "let me think about it" without re-closing</li>
    </ul>
    <div class="example"><b>What scores well</b>A rep who hears "I gotta talk to my wife" → runs the Deaf Ear → finds out it's actually about cost → offers the Coupon Drop → closes at half-off enrollment. That's the full sequence, in order, executed cleanly.</div>
  </div>

  <div class="cat" style="--cat-color:#7C3AED;">
    <div class="cat-head"><div class="cat-name">Language &amp; Psychology</div><div class="cat-pts">25 pts</div></div>
    <div class="what-it-tests">What it tests</div>
    <p>How you talk. The wording you choose creates the prospect's emotional state, and that state determines whether they buy. This category is ONLY about the language itself — not about which sales moves you ran.</p>
    <ul>
      <li class="good"><b>Strategic questions</b> — tie-downs ("Did you like the gym?"), engineered-yes questions ("Would that help you out?", "Is that fair?", "Would you like me to grab that for you?"), and "Make sense?" check-ins. These ARE the technique.</li>
      <li class="good">Assumptive language throughout — "Which one would you like to get started with today" not "Do you want to join?"</li>
      <li class="good">Calm and warm after objections — no caving, no defensiveness</li>
      <li class="good">Tie-downs run when buying signals appeared</li>
      <li class="bad"><b>True permission-seeking</b> — "Do you want to join?", "Are you ready?", "What do you think?" after pricing. These give the prospect an out where forward motion was the move.</li>
      <li class="bad">Hedge phrases that re-introduce a decision point you already closed: "Do you have your ID <i>to get you started</i>?" instead of "Do you have your ID and I can create your profile."</li>
    </ul>
    <div class="callout">
      <div class="callout-head">Important — what this category does NOT cover</div>
      <p>Missing the Coupon Drop is an Objection Handling miss, not a Language miss. Missing the referral collection is a Close Execution miss, not a Language miss. <b>One gap, one category.</b> If your wording was clean, this category scores high — even if you missed a post-close move.</p>
    </div>
  </div>

  <div class="cat" style="--cat-color:#EC4899;">
    <div class="cat-head"><div class="cat-name">Close Execution</div><div class="cat-pts">25 pts</div></div>
    <div class="what-it-tests">What it tests</div>
    <p>Everything from the moment the prospect picks a tier through the end of the visit. The close itself, ID collection, and the post-close moves that build the business.</p>
    <ul>
      <li class="good">Direct assumptive close attempted: "Which one would you like to get started with today?"</li>
      <li class="good"><b>Assumed ID collection</b> as a STATEMENT of forward motion: "Awesome. Do you have your ID and I can create your profile."</li>
      <li class="good">Re-closed after objections without skipping sequence</li>
      <li class="good"><b>By The Way Close</b> at end of free pass visits</li>
      <li class="good"><b>PIF (paid in full) offered after sign-up:</b> "If you pay for the full year today, I can give you 20% off and 2 months free. Which works better?"</li>
      <li class="good"><b>Referrals collected at point of sale</b> (right after taking the ID): "Your first month only, you can bring 5 people for free. Do you have your phone? Write down whoever you'd like to give a free pass to." Then silence while they write.</li>
      <li class="bad">Hedge phrases at ID collection: "Do you have your ID to get you started?" / "to set you up?" — those re-introduce a decision point</li>
      <li class="bad">Letting the prospect leave the desk to "think about it" without running the re-close</li>
      <li class="bad">Skipping PIF and referrals after a successful close — those are real dollars left on the table</li>
    </ul>
  </div>

  <h2 class="section">What the <span class="accent">Total Score</span> Means</h2>
  <div class="thresholds">
    <div class="thresh t85">
      <div class="thresh-num">85+</div>
      <div class="thresh-label">Excellence</div>
      <div class="thresh-desc">You've internalized the psychology. This is the bar for "expert closer." The coaching note will celebrate plainly and name maybe one refinement.</div>
    </div>
    <div class="thresh t70">
      <div class="thresh-num">70–84</div>
      <div class="thresh-label">Solid · Passing</div>
      <div class="thresh-desc">The fundamentals are there. The coaching note will name 1–2 specific refinements. Anything 70+ is considered a passing consult.</div>
    </div>
    <div class="thresh tlow">
      <div class="thresh-num">&lt;70</div>
      <div class="thresh-label">Needs Work</div>
      <div class="thresh-desc">Structural moves are missing. Coaching call territory — the rep needs targeted training on whichever category scored lowest. Auto-flagged for review.</div>
    </div>
  </div>

  <h2 class="section">How "Did You <span class="accent">Close?</span>" Is Decided</h2>
  <div class="cat" style="--cat-color:#22D3EE;">
    <div class="closing-def"><b>did_close = true</b> ONLY if a paid membership was actually sold during the consult — payment information collected, ID taken, agreements signed for a paid plan.</div>
    <div class="closing-def-sub">Free pass sign-ups are NOT closes. "I'll come back" is NOT a close. "I'll text you" is NOT a close. The model is told to be honest about this — soft maybes don't count.</div>
  </div>

  <h2 class="section">The <span class="accent">Philosophy</span> Behind the Score</h2>
  <div class="callout">
    <div class="callout-head">Read this if you read nothing else</div>
    <p><b>The script is a teaching scaffold, not the bar.</b> Most franchisees walk in with zero sales experience. The Aira script gives you a structure to develop habits inside of while you build psychology fluency of your own.</p>
    <p><b>If you close off-script using your own creative move, that's a WIN.</b> The model will celebrate it and explain WHY your move worked at a psychological level — which driver you activated, what feeling you created. The exact wording is the vehicle. Understanding is the destination.</p>
  </div>

  <div class="outro">
    Want to see this in action? <a href="/practice" target="_blank">Try the Practice Bot</a> &nbsp;or&nbsp; <a href="/airafitnessclosinggame" target="_blank">Play the Closing Game</a>
  </div>

</div></div>
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
html,body{min-height:100%;}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Arial,sans-serif;
  background:#05080F;
  color:#E5E7EB;
  -webkit-font-smoothing:antialiased;
  position:relative;
  min-height:100vh;
  overflow-x:hidden;
}
body.embed-mode .header{display:none;}
/* Animated aurora background */
body::before{
  content:'';position:fixed;inset:-50%;
  background:
    radial-gradient(ellipse 60% 40% at 20% 20%, rgba(0,174,239,0.20), transparent 60%),
    radial-gradient(ellipse 50% 50% at 80% 30%, rgba(124,58,237,0.16), transparent 60%),
    radial-gradient(ellipse 70% 50% at 50% 90%, rgba(236,72,153,0.10), transparent 60%);
  filter:blur(40px);z-index:0;animation:auroraShift 20s ease-in-out infinite alternate;
}
@keyframes auroraShift{0%{transform:translate(0,0) rotate(0);}100%{transform:translate(-3%,3%) rotate(2deg);}}
body::after{
  content:'';position:fixed;inset:0;z-index:0;pointer-events:none;opacity:0.7;
  background-image:
    radial-gradient(1px 1px at 12% 18%, rgba(255,255,255,0.4), transparent),
    radial-gradient(1px 1px at 47% 73%, rgba(0,174,239,0.5), transparent),
    radial-gradient(1px 1px at 82% 27%, rgba(255,255,255,0.3), transparent),
    radial-gradient(1px 1px at 33% 88%, rgba(124,58,237,0.4), transparent),
    radial-gradient(1px 1px at 67% 52%, rgba(255,255,255,0.35), transparent),
    radial-gradient(2px 2px at 15% 65%, rgba(0,174,239,0.6), transparent);
  background-size:100% 100%;
}

.app{position:relative;z-index:1;min-height:100vh;display:flex;flex-direction:column;}
.shell{max-width:760px;width:100%;margin:0 auto;flex:1;display:flex;flex-direction:column;padding:20px 24px;}

/* HEADER */
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;padding-top:8px;flex-wrap:wrap;gap:12px;}
.logo{font-size:18px;font-weight:900;letter-spacing:.2em;}
.logo .b{color:#00AEEF;text-shadow:0 0 24px rgba(0,174,239,.55);}
.logo .w{color:#fff;}
.logo .badge{display:inline-block;margin-left:14px;padding:4px 12px;background:linear-gradient(135deg,#00AEEF,#7C3AED);color:#fff;border-radius:999px;font-size:11px;letter-spacing:.16em;text-shadow:none;font-weight:800;}
.header-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.header-link{display:inline-flex;align-items:center;padding:7px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#9CA3AF;border-radius:999px;font-size:12px;font-weight:700;text-decoration:none;letter-spacing:.04em;transition:all .15s;}
.header-link:hover{border-color:rgba(0,174,239,0.4);color:#22D3EE;}
.header-link.game{background:rgba(0,174,239,0.08);border-color:rgba(0,174,239,0.3);color:#22D3EE;}
.header-link.game:hover{background:rgba(0,174,239,0.15);}

.stage{flex:1;display:flex;flex-direction:column;min-height:0;}

/* SPLASH */
.splash{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:20px 0 40px;}
.splash h1{
  font-size:clamp(36px,6vw,60px);font-weight:900;line-height:1;letter-spacing:-.02em;
  background:linear-gradient(120deg,#00AEEF 0%,#7C3AED 50%,#EC4899 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  margin-bottom:14px;filter:drop-shadow(0 4px 24px rgba(0,174,239,.3));
  animation:slideUp .7s ease-out;
}
.splash .tag{font-size:15px;color:#9CA3AF;margin-bottom:32px;max-width:520px;line-height:1.6;animation:slideUp .9s ease-out;}
.splash .tag a{color:#22D3EE;font-weight:700;text-decoration:none;}
.splash .tag a:hover{text-decoration:underline;}
@keyframes slideUp{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:translateY(0);}}

.start-card{
  background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);
  border-radius:18px;padding:28px;width:100%;max-width:480px;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  box-shadow:0 8px 40px rgba(0,0,0,0.3),inset 0 1px 0 rgba(255,255,255,0.05);
  animation:slideUp 1.1s ease-out;text-align:left;
}
label.fld{display:block;margin-bottom:16px;}
label.fld > span{display:block;font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.14em;font-weight:800;margin-bottom:8px;}
label.fld select{
  width:100%;padding:12px 14px;background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#fff;font-size:14px;font-family:inherit;
  transition:border-color .2s,background .2s;
}
label.fld select:focus{outline:none;border-color:#00AEEF;background:rgba(0,174,239,0.06);}
label.fld select option{background:#0A0F1E;color:#fff;}

.coach-toggle{
  display:flex !important;align-items:flex-start;gap:12px;padding:16px;
  background:linear-gradient(135deg,rgba(0,174,239,0.08),rgba(124,58,237,0.06));
  border:1px solid rgba(0,174,239,0.25) !important;border-radius:12px;cursor:pointer;
  margin-bottom:18px !important;transition:border-color .2s;
}
.coach-toggle:hover{border-color:rgba(0,174,239,0.5) !important;}
.coach-toggle input{margin-top:3px;flex-shrink:0;cursor:pointer;width:18px;height:18px;accent-color:#00AEEF;}
.coach-toggle .ct-body{display:block;letter-spacing:0;text-transform:none;color:#E5E7EB;font-weight:500;font-size:13px;line-height:1.55;margin-bottom:0;}
.coach-toggle .ct-title{font-weight:800;display:block;margin-bottom:4px;letter-spacing:0;text-transform:none;color:#22D3EE;font-size:14px;}
.coach-toggle .ct-new{font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;background:linear-gradient(135deg,#00AEEF,#7C3AED);color:#fff;padding:2px 8px;border-radius:9999px;margin-left:6px;vertical-align:middle;}

button.cta{
  width:100%;padding:14px 24px;
  background:linear-gradient(135deg,#00AEEF 0%,#7C3AED 100%);
  border:0;color:#fff;border-radius:12px;font-size:14px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;
  cursor:pointer;box-shadow:0 8px 24px rgba(0,174,239,.35);
  transition:transform .15s,box-shadow .15s,filter .15s;font-family:inherit;
}
button.cta:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(0,174,239,.45);filter:brightness(1.08);}
button.cta:active{transform:translateY(0);}
button.cta:disabled{opacity:.5;cursor:wait;transform:none;}
button.cta.secondary{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);box-shadow:none;}
button.cta.secondary:hover{background:rgba(255,255,255,0.1);}

/* CHAT */
.chat-frame{
  background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);
  border-radius:18px;display:flex;flex-direction:column;height:calc(100vh - 160px);min-height:480px;
  overflow:hidden;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
}
.chat-header{padding:16px 22px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;gap:12px;flex-wrap:wrap;}
.chat-persona{font-size:12px;color:#9CA3AF;font-weight:600;}
.chat-persona b{color:#fff;}
.chat-end{padding:8px 16px;background:rgba(220,38,38,0.1);border:1px solid rgba(220,38,38,0.3);color:#FCA5A5;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;font-family:inherit;transition:background .2s;}
.chat-end:hover{background:rgba(220,38,38,0.18);}
.chat-end:disabled{opacity:.5;cursor:wait;}

.chat-body{flex:1;overflow-y:auto;padding:22px;display:flex;flex-direction:column;gap:10px;}
.bubble{max-width:78%;padding:12px 16px;border-radius:18px;font-size:14px;line-height:1.55;animation:fadeIn .25s ease-out;}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}
.bubble.prospect{background:rgba(255,255,255,0.06);color:#E5E7EB;align-self:flex-start;border-bottom-left-radius:6px;}
.bubble.rep{background:linear-gradient(135deg,#0284C7,#00AEEF);color:#fff;align-self:flex-end;border-bottom-right-radius:6px;box-shadow:0 4px 16px rgba(0,174,239,0.25);}
.bubble.thinking{background:rgba(255,255,255,0.04);color:#6B7280;align-self:flex-start;font-style:italic;border-bottom-left-radius:6px;}

/* Scene-setter card — appears once at start of each consult */
.scene-set{
  align-self:stretch;max-width:100%;
  background:linear-gradient(135deg,rgba(0,174,239,0.06),rgba(124,58,237,0.06));
  border:1px solid rgba(0,174,239,0.25);border-left:4px solid #00AEEF;
  border-radius:12px;padding:16px 18px;margin-bottom:6px;
  animation:fadeIn .25s ease-out;
}
.scene-eyebrow{font-size:10px;font-weight:800;letter-spacing:.14em;color:#22D3EE;text-transform:uppercase;margin-bottom:6px;}
.scene-title{font-size:16px;font-weight:800;color:#fff;letter-spacing:-.005em;margin-bottom:6px;}
.scene-body{font-size:13.5px;color:#D1D5DB;line-height:1.6;}
.scene-body b{color:#fff;font-weight:700;}

/* Coach hints — dark glass with brand-blue (on-track) or amber (off-track) */
.coach-bubble{align-self:stretch;max-width:100%;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-left:4px solid #F59E0B;border-radius:12px;padding:14px 16px;margin:2px 0;animation:fadeIn .25s ease-out;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}
.coach-bubble.on{background:rgba(34,197,94,0.06);border-color:rgba(34,197,94,0.3);border-left-color:#22C55E;}
.coach-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
.coach-icon{font-size:14px;}
.coach-label{font-size:10px;font-weight:800;color:#FBBF24;letter-spacing:.14em;text-transform:uppercase;}
.coach-bubble.on .coach-label{color:#86EFAC;}
.coach-note{font-size:13.5px;color:#FED7AA;line-height:1.55;font-weight:500;}
.coach-bubble.on .coach-note{color:#BBF7D0;}
.coach-suggest{background:rgba(0,0,0,0.3);border:1px solid rgba(245,158,11,0.3);border-radius:10px;padding:12px 14px;margin-top:12px;}
.coach-suggest-label{font-size:9px;font-weight:800;color:#FBBF24;letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px;}
.coach-suggest-text{font-size:13.5px;color:#fff;line-height:1.55;font-style:italic;margin-bottom:10px;}
.coach-use{padding:6px 12px;background:linear-gradient(135deg,#00AEEF,#7C3AED);color:#fff;border:0;border-radius:8px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;font-family:inherit;transition:filter .15s;}
.coach-use:hover{filter:brightness(1.1);}

/* VOICE MODE */
.voice-toggle .ct-title{color:#A78BFA;}
.voice-stage{padding:28px 22px;display:flex;flex-direction:column;align-items:center;gap:14px;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;}
.voice-orb{position:relative;width:120px;height:120px;display:flex;align-items:center;justify-content:center;}
.voice-orb-inner{position:absolute;inset:18px;background:radial-gradient(circle at 30% 30%,#60A5FA,#7C3AED 60%,#1E1B4B);border-radius:50%;box-shadow:0 0 40px rgba(124,58,237,0.45),inset 0 0 30px rgba(255,255,255,0.18);transition:transform .25s ease,box-shadow .25s ease;}
.voice-orb-pulse{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(124,58,237,0.5);opacity:0;}
.voice-orb.listening .voice-orb-inner{transform:scale(1.06);box-shadow:0 0 60px rgba(0,174,239,0.7),inset 0 0 30px rgba(255,255,255,0.25);background:radial-gradient(circle at 30% 30%,#22D3EE,#00AEEF 60%,#0C4A6E);}
.voice-orb.listening .voice-orb-pulse{animation:voicePulse 1.4s ease-out infinite;border-color:rgba(0,174,239,0.6);}
.voice-orb.speaking .voice-orb-inner{transform:scale(1.12);box-shadow:0 0 70px rgba(236,72,153,0.6),inset 0 0 30px rgba(255,255,255,0.3);background:radial-gradient(circle at 30% 30%,#F472B6,#EC4899 60%,#4C1D95);}
.voice-orb.speaking .voice-orb-pulse{animation:voicePulse 1.0s ease-out infinite;border-color:rgba(236,72,153,0.6);}
@keyframes voicePulse{0%{opacity:0.8;transform:scale(1);}100%{opacity:0;transform:scale(1.45);}}
.voice-status{font-size:14px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#22D3EE;}
.voice-orb.speaking ~ .voice-status,.voice-orb.speaking + .voice-status{color:#F472B6;}
.voice-hint{font-size:12.5px;color:#9CA3AF;text-align:center;max-width:420px;line-height:1.5;}
.voice-error{padding:14px 18px;background:rgba(220,38,38,0.1);border:1px solid rgba(220,38,38,0.35);border-radius:10px;color:#FCA5A5;font-size:13px;margin:14px 22px;}

.chat-input{padding:16px;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:10px;align-items:flex-end;flex-shrink:0;}
.chat-input textarea{flex:1;padding:12px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:#fff;font-size:14px;font-family:inherit;resize:none;min-height:46px;max-height:140px;line-height:1.4;transition:border-color .2s;}
.chat-input textarea:focus{outline:none;border-color:#00AEEF;background:rgba(0,174,239,0.04);}
.chat-input textarea::placeholder{color:#6B7280;}
.chat-input button{padding:12px 22px;background:linear-gradient(135deg,#00AEEF,#7C3AED);border:0;color:#fff;border-radius:12px;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit;letter-spacing:.04em;text-transform:uppercase;transition:transform .15s,filter .15s;flex-shrink:0;}
.chat-input button:hover{filter:brightness(1.1);transform:translateY(-1px);}
.chat-input button:disabled{opacity:.5;cursor:wait;transform:none;}

/* SCORE SCREEN */
.score-screen{padding:0 0 24px;}
.celebration{
  text-align:center;padding:40px 24px;
  background:linear-gradient(135deg,rgba(0,174,239,0.08),rgba(124,58,237,0.08));
  border:1px solid rgba(255,255,255,0.1);
  border-radius:20px;margin-bottom:18px;animation:slideUp .6s ease-out;
}
.celebration h2{
  font-size:clamp(28px,5vw,44px);font-weight:900;line-height:1;
  background:linear-gradient(120deg,#22D3EE,#7C3AED,#EC4899);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  letter-spacing:-.02em;margin-bottom:14px;
  filter:drop-shadow(0 4px 24px rgba(0,174,239,.4));
}
.celebration .sub{font-size:14px;color:#9CA3AF;margin-bottom:18px;max-width:520px;margin-left:auto;margin-right:auto;line-height:1.6;}
.celebration .score-display{display:inline-flex;align-items:baseline;gap:6px;font-weight:900;font-size:64px;letter-spacing:-.03em;}
.celebration .score-display .of{font-size:22px;color:#9CA3AF;font-weight:700;}
.celebration.win .score-display{color:#22D3EE;text-shadow:0 0 32px rgba(34,211,238,0.5);}
.celebration.fail .score-display{color:#EC4899;}
.closed-pill{display:inline-block;padding:6px 14px;background:#0A0A0A;color:#fff;border-radius:9999px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-top:14px;}
.closed-pill.no{background:rgba(220,38,38,0.15);border:1px solid rgba(220,38,38,0.4);color:#FCA5A5;}
.closed-pill .check{color:#22D3EE;}

.scorecard-block{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:24px;margin-bottom:14px;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);}
.section-eyebrow{font-size:10px;font-weight:800;color:#9CA3AF;text-transform:uppercase;letter-spacing:.14em;margin-bottom:14px;}
.score-summary{padding:16px 18px;background:rgba(0,174,239,0.06);border-left:3px solid #00AEEF;border-radius:8px;margin-bottom:14px;font-size:14px;color:#E5E7EB;line-height:1.65;}
.cat-row{margin-top:14px;}
.cat-row-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;}
.cat-label{font-size:13px;font-weight:700;color:#fff;}
.cat-score{font-size:14px;font-weight:800;}
.cat-bar{background:rgba(255,255,255,0.08);border-radius:9999px;height:6px;overflow:hidden;}
.cat-bar-fill{height:6px;border-radius:9999px;transition:width .8s cubic-bezier(.2,.7,.3,1);}
.cat-explainer{font-size:12.5px;color:#9CA3AF;line-height:1.55;margin-top:6px;}

.coaching{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-left:3px solid #00AEEF;border-radius:10px;padding:22px 24px;margin-top:14px;}
.coaching .head{font-size:11px;font-weight:800;color:#22D3EE;text-transform:uppercase;letter-spacing:.14em;margin-bottom:14px;}
.coaching .body{font-size:14px;color:#E5E7EB;line-height:1.7;}
.coaching .body p{margin-top:12px;}
.coaching .body p:first-child{margin-top:0;}

.btn-row{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;}
.spinner-row{display:flex;align-items:center;gap:14px;margin-top:18px;justify-content:center;}
.spinner{width:20px;height:20px;border:2.5px solid rgba(255,255,255,0.1);border-top-color:#00AEEF;border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0;}
@keyframes spin{to{transform:rotate(360deg);}}

.hidden{display:none !important;}
</style></head><body>

<div class="app">
  <div class="shell">

    <div class="header">
      <div class="logo"><span class="b">AIRA</span><span class="w">FITNESS</span><span class="badge">PRACTICE BOT</span></div>
      <div class="header-right">
        <a href="/scoring" target="_blank" class="header-link">📊 How Scoring Works</a>
        <a href="/airafitnessclosinggame" class="header-link game">🎮 Closing Game →</a>
      </div>
    </div>

    <div class="stage">

      <!-- SPLASH -->
      <div id="start" class="splash">
        <h1>Practice Bot</h1>
        <p class="tag">Run a mock consult against an AI prospect — same psychology as the real floor. Get scored at the end. Try <b style="color:#22D3EE;">Coached Mode</b> for real-time hints while you train.</p>
        <div class="start-card">
          <label class="fld"><span>Difficulty</span>
            <select id="difficulty">${diffOptions}</select>
          </label>
          <label class="fld"><span>Your Gym</span>
            <select id="location"><option value="">— Select your gym —</option>${locOptions}</select>
          </label>
          <label class="coach-toggle">
            <input id="coach-mode" type="checkbox" />
            <span class="ct-body">
              <span class="ct-title">💡 Coached Mode <span class="ct-new">NEW</span></span>
              Real-time hints when you go off-script. After each thing you type, we tell you if it was the right move and suggest better wording when it wasn't. Best for new reps still learning.
            </span>
          </label>
          <label class="coach-toggle voice-toggle">
            <input id="voice-mode" type="checkbox" />
            <span class="ct-body">
              <span class="ct-title">🎙️ Voice Mode <span class="ct-new">NEW</span></span>
              Speak to the prospect out loud like a real consult. Your mic feeds the AI, the prospect speaks back. <b style="color:#FBBF24;">Use headphones</b> — phone speakers cause echo that confuses the AI. Coached hints not available in voice mode yet — coming soon.
            </span>
          </label>
          <button class="cta" id="start-btn">Start Consult →</button>
        </div>
      </div>

      <!-- CHAT -->
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

      <!-- VOICE CHAT -->
      <div id="voice" class="chat-frame hidden">
        <div class="chat-header">
          <div class="chat-persona">🎙️ Voice consult with: <b id="voice-persona-label">—</b></div>
          <button class="chat-end" id="voice-end-btn">End &amp; Score</button>
        </div>
        <div class="voice-stage">
          <div class="voice-orb" id="voice-orb">
            <div class="voice-orb-inner"></div>
            <div class="voice-orb-pulse"></div>
          </div>
          <div class="voice-status" id="voice-status">Connecting…</div>
          <div class="voice-hint" id="voice-hint">Speak naturally when the prospect finishes. The AI will respond out loud.</div>
        </div>
        <div class="chat-body" id="voice-messages"></div>
      </div>

      <!-- SCORE -->
      <div id="score" class="score-screen hidden"></div>

    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let SESSION_ID = null;
let SCENARIO_ID = '';
let COACH_MODE = false;
const QUERY_PARAMS = new URLSearchParams(window.location.search);
const EMBED_MODE = QUERY_PARAMS.get('embed') === '1';
const PLAYER_NAME = (QUERY_PARAMS.get('name') || '').trim();

function applyEmbedMode(){
  if (EMBED_MODE) document.body.classList.add('embed-mode');
}

function ensureLocationOption(location_id, label){
  if (!location_id) return;
  const select = $('location');
  if (!select) return;
  const exists = Array.from(select.options).some(opt => opt.value === location_id);
  if (!exists) {
    const option = document.createElement('option');
    option.value = location_id;
    option.textContent = label || 'Assigned gym';
    select.appendChild(option);
  }
}
function applyQueryLocations(){
  const raw = QUERY_PARAMS.get('locations');
  if (!raw) return;
  let locations = [];
  try {
    locations = JSON.parse(raw);
  } catch (err) {
    console.warn('[Embed] Could not parse locations query param', err);
    return;
  }
  if (!Array.isArray(locations) || !locations.length) return;
  const select = $('location');
  if (!select) return;
  select.innerHTML = '<option value="">— Select your gym —</option>';
  locations
    .filter(loc => loc && loc.id)
    .forEach(loc => {
      const option = document.createElement('option');
      option.value = loc.id;
      option.textContent = loc.name || loc.id;
      select.appendChild(option);
    });
}

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

// Voice mode disables coach mode (Milestone 1 — coach hints coming in M2).
$('voice-mode').addEventListener('change', () => {
  if ($('voice-mode').checked) {
    $('coach-mode').checked = false;
    $('coach-mode').disabled = true;
  } else {
    $('coach-mode').disabled = false;
  }
});

$('start-btn').onclick = async () => {
  const difficulty = $('difficulty').value;
  const location_id = $('location').value;
  const coach_mode = $('coach-mode').checked;
  const voice_mode = $('voice-mode').checked;
  if (!location_id) { alert('Please select your gym'); return; }
  $('start-btn').disabled = true;
  $('start-btn').textContent = 'Starting…';
  if (voice_mode) {
    try {
      await startVoiceConsult({ difficulty, location_id });
    } catch (err) {
      alert('Voice mode error: ' + (err.message || err));
      $('start-btn').disabled = false;
      $('start-btn').textContent = 'Start Consult →';
    }
    return;
  }
  const r = await postJson('/practice/start', { difficulty, location_id, coach_mode, player_name: PLAYER_NAME || null });
  if (!r.ok) { alert('Error: ' + r.error); $('start-btn').disabled = false; $('start-btn').textContent = 'Start Consult →'; return; }
  SESSION_ID = r.session_id;
  SCENARIO_ID = r.scenario_id || '';
  COACH_MODE = !!r.coach_mode;
  $('persona-label').textContent = r.persona_label + (r.persona_name ? ' — ' + r.persona_name : '') + (COACH_MODE ? ' · 💡 COACHED MODE' : '');
  $('start').classList.add('hidden');
  $('chat').classList.remove('hidden');
  // Scene-set card so franchisees know exactly where they are in the consult
  sceneSet(r.persona_name || 'the prospect');
  bubble('prospect', r.opening);
  $('rep-input').focus();
};

// ─────────── VOICE MODE CLIENT ───────────
// Uses OpenAI Realtime API over WebRTC for bidirectional audio with the prospect persona.
// The server mints an ephemeral key tied to a regular practice session; we hand the
// transcript back to /practice/end at the close for scoring with the existing rubric.
let VOICE_PC = null;
let VOICE_DC = null;
let VOICE_AUDIO_EL = null;
let VOICE_LOCAL_STREAM = null;
let VOICE_TRANSCRIPT = []; // [{ role: 'user'|'assistant', content }]
let VOICE_PENDING_ASSISTANT = ''; // accumulates assistant text deltas

function voiceSetStatus(text, mode) {
  $('voice-status').textContent = text;
  const orb = $('voice-orb');
  orb.classList.remove('listening', 'speaking');
  if (mode === 'listening') orb.classList.add('listening');
  if (mode === 'speaking') orb.classList.add('speaking');
}

function voiceAppendMessage(role, content) {
  if (!content || !content.trim()) return;
  VOICE_TRANSCRIPT.push({ role, content: content.trim() });
  const div = document.createElement('div');
  div.className = 'bubble ' + (role === 'user' ? 'rep' : 'prospect');
  div.textContent = content.trim();
  $('voice-messages').appendChild(div);
  $('voice-messages').scrollTop = $('voice-messages').scrollHeight;
}

async function startVoiceConsult({ difficulty, location_id }) {
  voiceSetStatus('Requesting microphone…', null);
  // 1. Request mic FIRST so the user grants permission before we burn an OpenAI session.
  // Echo cancellation + noise suppression are critical on phone speakers — otherwise the
  // prospect's voice plays through the speaker, gets picked up by the mic, and Whisper
  // transcribes it as user input (= the AI talks to itself in a loop).
  let micStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    throw new Error('Microphone access denied. Voice mode needs your mic.');
  }
  VOICE_LOCAL_STREAM = micStream;

  // 2. Mint ephemeral OpenAI session on the server.
  voiceSetStatus('Starting session…', null);
  const r = await postJson('/practice/voice/session', {
    difficulty, location_id, player_name: PLAYER_NAME || null,
  });
  if (!r.ok) {
    micStream.getTracks().forEach((t) => t.stop());
    throw new Error(r.error || 'Failed to start voice session');
  }
  SESSION_ID = r.session_id;
  SCENARIO_ID = r.scenario_id || '';
  COACH_MODE = false;
  VOICE_TRANSCRIPT = [];
  VOICE_PENDING_ASSISTANT = '';

  $('voice-persona-label').textContent = r.persona_label + (r.persona_name ? ' — ' + r.persona_name : '');
  $('start').classList.add('hidden');
  $('voice').classList.remove('hidden');

  // 3. WebRTC peer connection. Audio in (mic) + audio out (prospect voice) + data channel.
  const pc = new RTCPeerConnection();
  VOICE_PC = pc;

  // Remote audio element for the prospect's voice. Must be in the DOM for iOS Safari
  // to actually play the stream. Use playsinline + muted=false; user gesture already
  // happened via the Start button so autoplay is allowed.
  VOICE_AUDIO_EL = document.createElement('audio');
  VOICE_AUDIO_EL.autoplay = true;
  VOICE_AUDIO_EL.setAttribute('playsinline', '');
  VOICE_AUDIO_EL.style.display = 'none';
  document.body.appendChild(VOICE_AUDIO_EL);
  pc.ontrack = (e) => {
    VOICE_AUDIO_EL.srcObject = e.streams[0];
    VOICE_AUDIO_EL.play().catch((err) => console.warn('[Voice] audio play err:', err));
  };

  // Send our mic.
  micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));

  // Data channel for control events + transcripts.
  const dc = pc.createDataChannel('oai-events');
  VOICE_DC = dc;
  dc.onopen = () => {
    voiceSetStatus('Listening…', 'listening');
  };
  dc.onmessage = (e) => {
    try { handleVoiceEvent(JSON.parse(e.data)); } catch (err) { console.error('voice event parse', err); }
  };
  dc.onclose = () => { voiceSetStatus('Call ended', null); };

  // 4. SDP handshake with OpenAI Realtime.
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdpResp = await fetch('https://api.openai.com/v1/realtime/calls?model=' + encodeURIComponent(r.model), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + r.ephemeral_key,
      'Content-Type': 'application/sdp',
    },
    body: offer.sdp,
  });
  if (!sdpResp.ok) {
    const txt = await sdpResp.text();
    cleanupVoice();
    throw new Error('OpenAI WebRTC handshake failed: ' + txt);
  }
  const answerSdp = await sdpResp.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  voiceSetStatus('Connecting…', null);
}

function handleVoiceEvent(ev) {
  const t = ev.type || '';
  if (t !== 'response.output_audio.delta' && t !== 'response.output_audio_transcript.delta') {
    console.log('[Voice ev]', t);
  }
  // Prospect started speaking — GA event name is response.output_audio.delta
  if (t === 'response.output_audio.delta' || t === 'response.output_audio_transcript.delta') {
    voiceSetStatus(($('voice-persona-label').textContent.split('—').pop() || 'Prospect').trim() + ' speaking…', 'speaking');
  }
  // User speech detected via server VAD
  if (t === 'input_audio_buffer.speech_started') {
    voiceSetStatus('You are speaking…', 'listening');
  }
  if (t === 'input_audio_buffer.speech_stopped') {
    voiceSetStatus('Thinking…', null);
  }
  // Capture user transcript (Whisper). GA preserves the beta event name here.
  if (t === 'conversation.item.input_audio_transcription.completed') {
    if (ev.transcript) voiceAppendMessage('user', ev.transcript);
  }
  // Capture assistant transcript — GA renamed audio_transcript to output_audio_transcript.
  if (t === 'response.output_audio_transcript.delta' && ev.delta) {
    VOICE_PENDING_ASSISTANT += ev.delta;
  }
  if (t === 'response.output_audio_transcript.done') {
    const finalText = (ev.transcript || VOICE_PENDING_ASSISTANT || '').trim();
    if (finalText) voiceAppendMessage('assistant', finalText);
    VOICE_PENDING_ASSISTANT = '';
  }
  if (t === 'response.done') {
    voiceSetStatus('Listening…', 'listening');
  }
  if (t === 'error') {
    console.error('[Voice] error event:', ev);
  }
}

function cleanupVoice() {
  try { if (VOICE_DC) VOICE_DC.close(); } catch (e) {}
  try { if (VOICE_PC) VOICE_PC.close(); } catch (e) {}
  try { if (VOICE_LOCAL_STREAM) VOICE_LOCAL_STREAM.getTracks().forEach((t) => t.stop()); } catch (e) {}
  VOICE_DC = null;
  VOICE_PC = null;
  VOICE_LOCAL_STREAM = null;
}

$('voice-end-btn').onclick = async () => {
  $('voice-end-btn').disabled = true;
  $('voice-end-btn').textContent = 'Scoring…';
  voiceSetStatus('Ending call…', null);
  cleanupVoice();
  if (VOICE_TRANSCRIPT.length < 4) {
    alert('Conversation too short to score — talk a bit more before ending the call.');
    $('voice-end-btn').disabled = false;
    $('voice-end-btn').textContent = 'End & Score';
    return;
  }
  try {
    const r = await postJson('/practice/end', { session_id: SESSION_ID, messages: VOICE_TRANSCRIPT });
    if (!r.ok) throw new Error(r.error || 'Score request failed');
    $('voice').classList.add('hidden');
    renderScorecard(r.scorecard, r.messages);
  } catch (err) {
    alert('Scoring failed: ' + err.message);
    $('voice-end-btn').disabled = false;
    $('voice-end-btn').textContent = 'End & Score';
  }
};

applyEmbedMode();
applyQueryLocations();
const queryLocationId = (QUERY_PARAMS.get('location_id') || '').trim();
if (queryLocationId) {
  ensureLocationOption(queryLocationId, (QUERY_PARAMS.get('location_name') || '').trim());
  $('location').value = queryLocationId;
}

function sceneSet(name) {
  const div = document.createElement('div');
  div.className = 'scene-set';
  div.innerHTML =
    '<div class="scene-eyebrow">📍 Scene</div>' +
    '<div class="scene-title">You just finished the tour.</div>' +
    '<div class="scene-body">' + name + ' is sitting at your desk waiting to hear about pricing. Your next move: <b>start the price presentation and go over the programs offered.</b></div>';
  $('messages').appendChild(div);
  $('messages').scrollTop = $('messages').scrollHeight;
}

const repInput = $('rep-input');
repInput.addEventListener('input', () => { repInput.style.height = 'auto'; repInput.style.height = Math.min(repInput.scrollHeight, 140) + 'px'; });
repInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send-btn').click(); }});

function coachBubble(coach) {
  if (!coach) return;
  const div = document.createElement('div');
  div.className = 'coach-bubble ' + (coach.on_track ? 'on' : 'off');
  const icon = coach.on_track ? '✓' : '💡';
  const label = coach.on_track ? 'COACH' : 'COACH · TRY THIS';
  let html = '<div class="coach-head"><span class="coach-icon">' + icon + '</span> <span class="coach-label">' + label + '</span></div>';
  if (coach.note) html += '<div class="coach-note">' + coach.note.replace(/</g,'&lt;') + '</div>';
  if (coach.suggestion && !coach.on_track) {
    const safe = coach.suggestion.replace(/</g,'&lt;').replace(/'/g,'&#39;');
    html += '<div class="coach-suggest"><div class="coach-suggest-label">SAY SOMETHING LIKE:</div><div class="coach-suggest-text">"' + safe + '"</div><button class="coach-use" onclick="useSuggestion(this.dataset.text)" data-text="' + safe + '">Use this →</button></div>';
  }
  div.innerHTML = html;
  $('messages').appendChild(div);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function useSuggestion(text) {
  repInput.value = text.replace(/&#39;/g, "'");
  repInput.focus();
  repInput.style.height = 'auto';
  repInput.style.height = Math.min(repInput.scrollHeight, 140) + 'px';
}

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
  if (COACH_MODE && r.coach) coachBubble(r.coach);
  bubble('prospect', r.reply);
  repInput.focus();
};

function resumeChat(){
  $('score').classList.add('hidden');
  $('chat').classList.remove('hidden');
  $('end-btn').disabled = false;
  $('end-btn').textContent = 'End & Score';
  $('rep-input').focus();
}

$('end-btn').onclick = async () => {
  if ($('end-btn').disabled) return;
  $('end-btn').disabled = true;
  $('end-btn').textContent = 'Scoring…';
  $('chat').classList.add('hidden');
  $('score').classList.remove('hidden');
  $('score').innerHTML = '<div class="celebration"><h2>Scoring…</h2><p class="sub">Analyzing your full conversation. This takes 20-40 seconds — don\\'t close the tab.</p><div class="spinner-row"><div class="spinner"></div><div style="color:#9CA3AF;font-size:13px;">Reading every move you made…</div></div></div>';
  try {
    const r = await postJson('/practice/end', { session_id: SESSION_ID });
    if (!r.ok) {
      const goBack = SESSION_ID ? '<button class="cta secondary" onclick="resumeChat()">← Back to consult</button> ' : '';
      $('score').innerHTML = '<div class="celebration fail"><h2>Couldn\\'t score yet</h2><p class="sub">' + r.error + '</p><div class="btn-row" style="justify-content:center;">' + goBack + '<button class="cta secondary" onclick="location.reload()">Start Over</button></div></div>';
      $('end-btn').disabled = false;
      $('end-btn').textContent = 'End & Score';
      return;
    }
    rememberScenario(r.scenario_id || SCENARIO_ID);
    renderScorecard(r.scorecard, r.messages);
  } catch (err) {
    $('score').innerHTML = '<div class="celebration fail"><h2>Connection Error</h2><p class="sub">Couldn\\'t reach the scorer. ' + (err.message || err) + '</p><div class="btn-row" style="justify-content:center;"><button class="cta secondary" onclick="resumeChat()">← Back to consult</button> <button class="cta" onclick="$(\\'end-btn\\').click()">Try scoring again</button></div></div>';
    $('end-btn').disabled = false;
    $('end-btn').textContent = 'End & Score';
  }
};

function colorFor(score, max) { const p = (score/max)*100; return p>=70?'#22D3EE':p>=50?'#0284C7':'#EC4899'; }
function escapeHtml(t) { return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function renderConversation(messages) {
  if (!messages || !messages.length) return '';
  const rows = messages.map(m => {
    const isRep = m.role === 'user';
    const label = isRep ? 'YOU SAID' : 'PROSPECT SAID';
    const labelColor = isRep ? '#22D3EE' : '#9CA3AF';
    const bg = isRep ? 'rgba(0,174,239,0.06)' : 'rgba(255,255,255,0.04)';
    const border = isRep ? 'rgba(0,174,239,0.2)' : 'rgba(255,255,255,0.08)';
    return '<div style="background:' + bg + ';border:1px solid ' + border + ';border-radius:8px;padding:10px 14px;margin-bottom:8px;">' +
      '<div style="font-size:10px;font-weight:800;letter-spacing:.14em;color:' + labelColor + ';margin-bottom:4px;">' + label + '</div>' +
      '<div style="font-size:13.5px;color:#E5E7EB;line-height:1.55;">' + escapeHtml(m.content) + '</div>' +
    '</div>';
  }).join('');
  return '<div class="scorecard-block"><div class="section-eyebrow">The Conversation</div>' + rows + '</div>';
}

function renderScorecard(s, messages) {
  const total = s.total_score || 0;
  const totalColor = colorFor(total, 100);
  const closed = s.did_close === true;
  const passed = closed && total >= 70;
  const win = passed;

  const headline = win ? (total >= 90 ? 'PERFECT EXECUTION' : 'STRONG WORK') : (closed ? 'CLOSED — BUT NOT QUITE' : 'PROSPECT WALKED');
  const sub = win ? ('You scored ' + total + ' and closed the sale. That is the bar.') : (closed ? ('You closed at ' + total + ' — passing the bar (in the game) requires 70+ AND a closed sale.') : 'No sale today. Read the coaching below — the script knows where the gap was.');

  const sections = [
    ['Sit-Down Presentation', s.sitdown_score || 0, s.sitdown_score_explainer],
    ['Objection Handling', s.objection_score || 0, s.objection_score_explainer],
    ['Language & Psychology', s.language_score || 0, s.language_score_explainer],
    ['Close Execution', s.close_score || 0, s.close_score_explainer],
  ];
  const catRows = sections.map(([label, score, expl]) => {
    const c = colorFor(score, 25);
    const pct = (score / 25) * 100;
    return '<div class="cat-row"><div class="cat-row-head"><div class="cat-label">' + label + '</div><div class="cat-score" style="color:' + c + ';">' + score + '<span style="color:#9CA3AF;font-weight:600;"> / 25</span></div></div><div class="cat-bar"><div class="cat-bar-fill" style="background:' + c + ';width:' + pct + '%;"></div></div>' + (expl ? '<div class="cat-explainer">' + expl + '</div>' : '') + '</div>';
  }).join('');
  const coaching = (s.overall_coaching || s.coaching_note || '').trim();
  const coachingHtml = coaching ? '<div class="coaching"><div class="head">Coaching Notes</div><div class="body"><p>' + coaching.replace(/\\n\\n+/g, '</p><p>').replace(/\\n/g, ' ') + '</p></div></div>' : '';

  $('score').innerHTML =
    '<div class="celebration ' + (win?'win':'fail') + '">' +
      '<h2>' + headline + '</h2>' +
      '<p class="sub">' + sub + '</p>' +
      '<div class="score-display">' + total + '<span class="of">/ 100</span></div>' +
      (closed ? '<div class="closed-pill"><span class="check">✓</span> SALE CLOSED</div>' : '<div class="closed-pill no">NO SALE</div>') +
    '</div>' +
    '<div class="scorecard-block"><div class="section-eyebrow">Score Breakdown</div>' + catRows + '</div>' +
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
    if (!ensureStaffLocationAccess(req, res, r.location_id)) return;
    const s = await db.getScorecardByRecording(req.params.id);
    if (!s)
      return res
        .status(404)
        .send(
          "Scorecard not yet available — check back after processing completes.",
        );
    const loc = byLocationId[resolveRecorderLocationId(r.location_id)] || {};
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
  <a href="${withStaffToken(req, "/admin")}" class="back">← Back to Admin</a>
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
  if (!ensureStaffLocationAccess(req, res, rec.location_id)) return;
  const name = rec.contact_name || rec.appointment_id;
  const loc = byLocationId[resolveRecorderLocationId(rec.location_id)] || {};
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
  <a href="${withStaffToken(req, "/admin")}" class="back">← Back to Admin</a>
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
function registerLocation(loc, aliases = []) {
  if (!loc?.location_id) return;
  const locationId = normalizeLocationId(loc.location_id);
  const normalized = { ...loc, location_id: locationId };
  byLocationId[locationId] = normalized;
  recorderLocationAliases.set(locationId, locationId);

  for (const alias of aliases || []) {
    const normalizedAlias = normalizeLocationId(alias);
    if (!normalizedAlias) continue;
    byLocationId[normalizedAlias] = normalized;
    recorderLocationAliases.set(normalizedAlias, locationId);
    const aliasIdx = ALL_LOCATIONS.findIndex(
      (x) =>
        normalizeLocationId(x.location_id) === normalizedAlias &&
        normalizedAlias !== locationId,
    );
    if (aliasIdx >= 0) ALL_LOCATIONS.splice(aliasIdx, 1);
  }

  const existingIdx = ALL_LOCATIONS.findIndex(
    (x) => normalizeLocationId(x.location_id) === locationId,
  );
  if (existingIdx >= 0) ALL_LOCATIONS[existingIdx] = normalized;
  else ALL_LOCATIONS.push(normalized);
}

async function syncAcsmLocations() {
  const secret = process.env.RECORDER_SYNC_SECRET;
  const apiBase =
    process.env.AIRA_API_BASE_URL || "https://api.airafitness.com";
  if (!secret) {
    console.log(
      "[ACSM Locations] RECORDER_SYNC_SECRET not configured; skipping sync",
    );
    return;
  }
  try {
    const { data } = await axios.get(`${apiBase}/internal/recorder/locations`, {
      headers: { "X-Aira-Internal-Secret": secret },
      timeout: 10000,
    });
    const locations = Array.isArray(data?.locations) ? data.locations : [];
    for (const row of locations) {
      registerLocation(
        {
          location_id: row.location_id || row.id,
          franchise_name: row.franchise_name || row.name || row.id,
          franchisee_name: "",
          franchisee_email:
            row.club_email ||
            process.env.MIKE_EMAIL ||
            "mikebell@airafitness.com",
          club_email: row.club_email || "",
          _acsm: true,
        },
        row.legacy_location_ids || [],
      );
    }
    console.log(`[ACSM Locations] Synced ${locations.length} ACSM location(s)`);
  } catch (err) {
    console.error("[ACSM Locations] sync failed:", err.message);
  }
}

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
      registerLocation(loc);
      if (loc.ghl_calendar_id) byCalendarId[loc.ghl_calendar_id] = loc;
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
    await syncAcsmLocations();
    setInterval(syncAcsmLocations, 15 * 60 * 1000).unref();
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
