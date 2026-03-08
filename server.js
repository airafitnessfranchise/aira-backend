// server.js
// ─────────────────────────────────────────────────────────
// Aira Fitness — Consult Recorder Backend
// ─────────────────────────────────────────────────────────

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { byCalendarId, byLocationId, locations } = require('./locations');
const db = require('./db');
const { transcribeAudio, scoreTranscript } = require('./ai');
const { sendScorecardEmail } = require('./email');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('public'));

// Ensure uploads directory exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Multer config for audio uploads
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${uuidv4()}.webm`);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB max

// ─────────────────────────────────────────────────────────
// WebSocket Server
// Manages persistent connections from all tablets
// ─────────────────────────────────────────────────────────

// Map: location_id → WebSocket connection
const tabletConnections = new Map();

wss.on('connection', (ws, req) => {
  console.log(`[WS] New connection from ${req.socket.remoteAddress}`);
  let registeredLocationId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      console.log(`[WS] Message received:`, msg);

      if (msg.type === 'register') {
        const locationId = msg.location_id;
        const loc = byLocationId[locationId];

        if (!loc) {
          ws.send(JSON.stringify({
            type: 'error',
            message: `Unknown location_id: ${locationId}`
          }));
          return;
        }

        // Store connection
        registeredLocationId = locationId;
        tabletConnections.set(locationId, ws);

        ws.send(JSON.stringify({
          type: 'registered',
          status: 'ok',
          location: loc.franchise_name,
          message: `Registered as ${loc.franchise_name}`
        }));

        console.log(`[WS] Tablet registered for location: ${locationId} (${loc.franchise_name})`);
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }

    } catch (e) {
      console.error('[WS] Failed to parse message:', e.message);
    }
  });

  ws.on('close', () => {
    if (registeredLocationId) {
      tabletConnections.delete(registeredLocationId);
      console.log(`[WS] Tablet disconnected: ${registeredLocationId}`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error:`, err.message);
  });

  // Send a welcome ping
  ws.send(JSON.stringify({ type: 'connected', message: 'Connected to Aira backend' }));
});

// Helper: send start signal to a specific tablet
function triggerTablet(location_id, appointment_id) {
  const ws = tabletConnections.get(location_id);

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn(`[WS] No active tablet connection for location: ${location_id}`);
    return false;
  }

  ws.send(JSON.stringify({
    action: 'start',
    appt_id: appointment_id,
    location: location_id
  }));

  console.log(`[WS] Triggered tablet at ${location_id} for appt ${appointment_id}`);
  return true;
}

// ─────────────────────────────────────────────────────────
// GHL Webhook
// POST /webhook/ghl-appointment
// ─────────────────────────────────────────────────────────

app.post('/webhook/ghl-appointment', (req, res) => {
  console.log('[GHL] Webhook received:', JSON.stringify(req.body, null, 2));

  const body = req.body;

  // GHL sends different payload shapes depending on trigger type
  // Try to extract the calendar ID from common field locations
  const calendarId =
    body.calendar_id ||
    body.calendarId ||
    body.calendar?.id ||
    body.appointment?.calendar_id ||
    null;

  const appointmentId =
    body.id ||
    body.appointment_id ||
    body.appointmentId ||
    body.appointment?.id ||
    uuidv4(); // fallback

  const contactName =
    body.contact_name ||
    body.contactName ||
    body.contact?.name ||
    'Unknown';

  console.log(`[GHL] Calendar ID: ${calendarId}, Appt ID: ${appointmentId}, Contact: ${contactName}`);

  // Look up location from calendar ID
  const location = calendarId ? byCalendarId[calendarId] : null;

  if (!location) {
    console.warn(`[GHL] No location found for calendar_id: ${calendarId}`);
    // Still return 200 so GHL doesn't keep retrying
    return res.json({
      success: false,
      message: `No location mapped to calendar_id: ${calendarId}`,
      received: body
    });
  }

  console.log(`[GHL] Matched location: ${location.franchise_name}`);

  // Create a recording record in DB
  const recording = db.createRecording({
    appointment_id: appointmentId,
    location_id: location.location_id
  });

  // Trigger the tablet
  const triggered = triggerTablet(location.location_id, appointmentId);

  res.json({
    success: true,
    location: location.franchise_name,
    appointment_id: appointmentId,
    recording_id: recording.recording_id,
    tablet_triggered: triggered
  });
});

// ─────────────────────────────────────────────────────────
// Audio Upload
// POST /upload/recording
// ─────────────────────────────────────────────────────────

app.post('/upload/recording', upload.single('audio_file'), async (req, res) => {
  console.log('[Upload] Audio file received');

  const { appointment_id, location_id, duration_seconds } = req.body;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ success: false, message: 'No audio file received' });
  }

  console.log(`[Upload] Appt: ${appointment_id}, Location: ${location_id}, Duration: ${duration_seconds}s, File: ${file.filename} (${file.size} bytes)`);

  // Update or create recording record
  let recording = null;

  // Try to find existing recording by appointment_id
  const allRecs = db.getAllRecordings();
  recording = allRecs.find(r => r.appointment_id === appointment_id);

  if (recording) {
    db.updateRecording(recording.recording_id, {
      audio_file_url: file.path,
      duration_seconds: parseInt(duration_seconds) || 0,
      processing_status: 'uploaded'
    });
  } else {
    recording = db.createRecording({
      appointment_id: appointment_id || `manual-${Date.now()}`,
      location_id: location_id || 'unknown',
      duration_seconds: parseInt(duration_seconds) || 0,
      audio_file_url: file.path
    });
  }

  res.json({
    success: true,
    recording_id: recording.recording_id,
    message: 'Audio received — processing started'
  });

  // Run AI pipeline async (don't block the response)
  processRecording(recording.recording_id, file.path, location_id, appointment_id);
});

// ─────────────────────────────────────────────────────────
// AI Processing Pipeline
// Runs after audio upload — transcribe → score → email
// ─────────────────────────────────────────────────────────

async function processRecording(recording_id, audioFilePath, location_id, appointment_id) {
  const location = byLocationId[location_id];

  try {
    // Step 1: Transcribe
    console.log(`[Pipeline] Starting transcription for ${recording_id}`);
    db.updateRecording(recording_id, { processing_status: 'transcribing' });

    const transcript = await transcribeAudio(audioFilePath);
    db.updateRecording(recording_id, {
      transcript,
      processing_status: 'transcribed'
    });

    // Step 2: Score
    console.log(`[Pipeline] Starting scoring for ${recording_id}`);
    db.updateRecording(recording_id, { processing_status: 'scoring' });

    const scorecard = await scoreTranscript(transcript);
    const savedScorecard = db.createScorecard({
      recording_id,
      scores: scorecard,
      coaching: scorecard,
      ai_summary: scorecard.ai_summary
    });

    db.updateRecording(recording_id, { processing_status: 'scored' });

    // Step 3: Send emails
    const date = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    if (location) {
      // Email franchisee
      await sendScorecardEmail({
        to: location.franchisee_email,
        franchisee_name: location.franchisee_name,
        date,
        scorecard: savedScorecard,
        appointment_id
      });

      // Email Mike if score below threshold
      const threshold = parseInt(process.env.FLAG_SCORE_THRESHOLD) || 70;
      if (savedScorecard.total_score < threshold) {
        console.log(`[Pipeline] Score ${savedScorecard.total_score} below threshold ${threshold} — emailing Mike`);
        await sendScorecardEmail({
          to: process.env.MIKE_EMAIL,
          franchisee_name: `${location.franchisee_name} (${location.franchise_name}) ⚠️ FLAGGED`,
          date,
          scorecard: savedScorecard,
          appointment_id
        });
      }
    }

    console.log(`[Pipeline] Complete for ${recording_id} — score: ${scorecard.total_score}/100`);

    // Clean up audio file from disk (optional — comment out to keep)
    // fs.unlinkSync(audioFilePath);

  } catch (err) {
    console.error(`[Pipeline] Error for ${recording_id}:`, err.message);
    db.updateRecording(recording_id, { processing_status: 'failed' });
  }
}

// ─────────────────────────────────────────────────────────
// Admin Dashboard
// GET /admin — simple page to see all recordings
// ─────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  const recordings = db.getAllRecordings();
  const scorecards = db.getAllScorecards();

  const scorecardMap = {};
  scorecards.forEach(s => { scorecardMap[s.recording_id] = s; });

  const rows = recordings.map(r => {
    const sc = scorecardMap[r.recording_id];
    const loc = byLocationId[r.location_id] || {};
    return `
      <tr>
        <td>${new Date(r.recorded_at).toLocaleString()}</td>
        <td>${loc.franchise_name || r.location_id}</td>
        <td>${r.appointment_id}</td>
        <td>${Math.round(r.duration_seconds / 60)}m ${r.duration_seconds % 60}s</td>
        <td><span class="status status-${r.processing_status}">${r.processing_status}</span></td>
        <td>${sc ? `<strong style="color:${sc.total_score >= 70 ? '#22c55e' : '#ef4444'}">${sc.total_score}/100</strong>` : '—'}</td>
        <td>${r.audio_file_url ? `<a href="/playback/${r.recording_id}">▶ Play</a>` : '—'}</td>
      </tr>`;
  }).join('');

  const connectedTablets = Array.from(tabletConnections.keys());

  res.send(`<!DOCTYPE html>
<html>
<head>
<title>Aira — Admin</title>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #0a0a0a; color: #f0f0f0; padding: 32px; }
  h1 { color: #c8f060; font-size: 24px; margin-bottom: 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 32px; }
  .cards { display: flex; gap: 16px; margin-bottom: 32px; flex-wrap: wrap; }
  .card { background: #111; border: 1px solid #222; border-radius: 12px; padding: 20px 24px; min-width: 160px; }
  .card-num { font-size: 32px; font-weight: bold; color: #c8f060; }
  .card-label { color: #666; font-size: 12px; margin-top: 4px; text-transform: uppercase; letter-spacing: 1px; }
  .tablets { background: #111; border: 1px solid #222; border-radius: 12px; padding: 20px; margin-bottom: 32px; }
  .tablets h2 { font-size: 14px; color: #888; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 12px; }
  .tablet-chip { display: inline-block; background: #1a2a0a; border: 1px solid #4a7a20; color: #c8f060; padding: 4px 12px; border-radius: 20px; font-size: 12px; margin-right: 8px; }
  .tablet-none { color: #555; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; background: #111; border-radius: 12px; overflow: hidden; }
  th { background: #1a1a1a; padding: 12px 16px; text-align: left; font-size: 11px; color: #666; letter-spacing: 1px; text-transform: uppercase; }
  td { padding: 12px 16px; border-bottom: 1px solid #1a1a1a; font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #141414; }
  a { color: #c8f060; text-decoration: none; }
  .status { padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; }
  .status-pending { background: #2a2a00; color: #ffcc00; }
  .status-uploaded { background: #002a2a; color: #00cccc; }
  .status-transcribing { background: #00002a; color: #6666ff; }
  .status-transcribed { background: #002a00; color: #00cc66; }
  .status-scoring { background: #2a1a00; color: #ff9900; }
  .status-scored { background: #0a2a0a; color: #c8f060; }
  .status-failed { background: #2a0000; color: #ff4444; }
</style>
</head>
<body>
  <h1>Aira Fitness — Consult Recorder</h1>
  <p class="sub">Admin Dashboard · Auto-refreshes every 30s</p>

  <div class="cards">
    <div class="card">
      <div class="card-num">${recordings.length}</div>
      <div class="card-label">Total Recordings</div>
    </div>
    <div class="card">
      <div class="card-num">${scorecards.length}</div>
      <div class="card-label">Scorecards</div>
    </div>
    <div class="card">
      <div class="card-num">${scorecards.filter(s => s.total_score >= 70).length}</div>
      <div class="card-label">Passing (≥70)</div>
    </div>
    <div class="card">
      <div class="card-num">${scorecards.filter(s => s.flagged_for_review).length}</div>
      <div class="card-label">Flagged</div>
    </div>
    <div class="card">
      <div class="card-num">${connectedTablets.length}</div>
      <div class="card-label">Tablets Online</div>
    </div>
  </div>

  <div class="tablets">
    <h2>Connected Tablets</h2>
    ${connectedTablets.length > 0
      ? connectedTablets.map(id => `<span class="tablet-chip">🟢 ${id}</span>`).join('')
      : '<span class="tablet-none">No tablets connected</span>'
    }
  </div>

  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Location</th>
        <th>Appt ID</th>
        <th>Duration</th>
        <th>Status</th>
        <th>Score</th>
        <th>Audio</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="7" style="text-align:center;color:#555;padding:40px;">No recordings yet</td></tr>'}
    </tbody>
  </table>

  <script>setTimeout(() => location.reload(), 30000);</script>
</body>
</html>`);
});

// ─── Playback endpoint ────────────────────────────────────
app.get('/playback/:recording_id', (req, res) => {
  const rec = db.getRecording(req.params.recording_id);
  if (!rec || !rec.audio_file_url) return res.status(404).send('Not found');

  res.send(`<!DOCTYPE html>
<html>
<head><title>Playback</title>
<style>body{background:#0a0a0a;color:#f0f0f0;font-family:Arial;padding:32px;} h2{color:#c8f060;}</style>
</head>
<body>
<h2>Recording Playback</h2>
<p style="color:#666;margin-bottom:16px;">Appt: ${rec.appointment_id} · ${new Date(rec.recorded_at).toLocaleString()}</p>
<audio controls style="width:100%;margin-bottom:24px;">
  <source src="/audio/${path.basename(rec.audio_file_url)}">
</audio>
${rec.transcript ? `<h3 style="color:#888;margin-bottom:8px;">Transcript</h3><p style="line-height:1.7;color:#ccc;">${rec.transcript}</p>` : '<p style="color:#555;">Transcript not yet available</p>'}
<p style="margin-top:16px;"><a href="/admin" style="color:#c8f060;">← Back to admin</a></p>
</body></html>`);
});

// Serve audio files
app.use('/audio', express.static(UPLOAD_DIR));

// ─── Status endpoint ──────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    tablets_connected: tabletConnections.size,
    tablets: Array.from(tabletConnections.keys()),
    recordings: db.getAllRecordings().length,
    scorecards: db.getAllScorecards().length,
    uptime_seconds: Math.round(process.uptime())
  });
});

// ─── Test trigger endpoint (for testing without GHL) ──────
app.post('/test/trigger', (req, res) => {
  const { location_id, appointment_id } = req.body;
  const apptId = appointment_id || `TEST-${Date.now()}`;
  const triggered = triggerTablet(location_id, apptId);

  const recording = db.createRecording({
    appointment_id: apptId,
    location_id
  });

  res.json({ triggered, appointment_id: apptId, recording_id: recording.recording_id });
});

// ─────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   Aira Consult Recorder — Backend     ║
║   Running on port ${PORT}                ║
║                                        ║
║   Admin:   /admin                      ║
║   Status:  /status                     ║
║   GHL:     POST /webhook/ghl-appt...  ║
║   Upload:  POST /upload/recording      ║
╚════════════════════════════════════════╝
  `);
  console.log(`[Locations] Loaded ${Object.keys(byLocationId).length} location(s)`);
});
