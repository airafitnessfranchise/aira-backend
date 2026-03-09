// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { byCalendarId, byLocationId } = require('./locations');
const db = require('./db');
const { transcribeAudio, scoreTranscript } = require('./ai');
const { sendScorecardEmail } = require('./email');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json());
app.use(express.static('public'));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => { cb(null, Date.now() + '-' + uuidv4() + '.webm'); }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ── WebSocket ─────────────────────────────────────────────
const tabletConnections = new Map();

wss.on('connection', (ws, req) => {
  console.log('[WS] New connection from ' + req.socket.remoteAddress);
  let registeredLocationId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'register') {
        const loc = byLocationId[msg.location_id];
        if (!loc) { ws.send(JSON.stringify({ type: 'error', message: 'Unknown location: ' + msg.location_id })); return; }
        registeredLocationId = msg.location_id;
        tabletConnections.set(msg.location_id, ws);
        ws.send(JSON.stringify({ type: 'registered', status: 'ok', location: loc.franchise_name, message: 'Registered as ' + loc.franchise_name }));
        console.log('[WS] Tablet registered for location: ' + msg.location_id + ' (' + loc.franchise_name + ')');
      }
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch(e) { console.error('[WS] Parse error:', e.message); }
  });

  ws.on('close', () => {
    if (registeredLocationId) { tabletConnections.delete(registeredLocationId); console.log('[WS] Tablet disconnected: ' + registeredLocationId); }
  });
  ws.on('error', (err) => console.error('[WS] Error:', err.message));
  ws.send(JSON.stringify({ type: 'connected', message: 'Connected to Aira backend' }));
});

function triggerTablet(location_id, appointment_id) {
  const ws = tabletConnections.get(location_id);
  if (!ws || ws.readyState !== WebSocket.OPEN) { console.warn('[WS] No active tablet for: ' + location_id); return false; }
  ws.send(JSON.stringify({ action: 'start', appt_id: appointment_id, location: location_id }));
  console.log('[WS] Triggered tablet at ' + location_id + ' for appt ' + appointment_id);
  return true;
}

// ── GHL Webhook ───────────────────────────────────────────
app.post('/webhook/ghl', (req, res) => {
  console.log('[GHL] Webhook received:', JSON.stringify(req.body, null, 2));
  const body = req.body;
  const calendarId = body.calendar_id || body.calendarId || body.calendar?.id || body.appointment?.calendar_id || null;
  const appointmentId = body.id || body.appointment_id || body.appointmentId || body.appointment?.id || uuidv4();
  const contactName = body.contact_name || body.contactName || body.contact?.name || 'Unknown';
  console.log('[GHL] Calendar: ' + calendarId + ', Appt: ' + appointmentId + ', Contact: ' + contactName);
  const location = calendarId ? byCalendarId[calendarId] : null;
  if (!location) { console.warn('[GHL] No location for calendar_id: ' + calendarId); return res.json({ success: false, message: 'No location mapped to ' + calendarId }); }
  const recording = db.createRecording({ appointment_id: appointmentId, location_id: location.location_id });
  const triggered = triggerTablet(location.location_id, appointmentId);
  res.json({ success: true, location: location.franchise_name, appointment_id: appointmentId, recording_id: recording.recording_id, tablet_triggered: triggered });
});

// ── Audio Upload ──────────────────────────────────────────
app.post('/upload/recording', upload.single('audio_file'), async (req, res) => {
  console.log('[Upload] Audio file received');
  const { appointment_id, location_id, duration_seconds } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ success: false, message: 'No audio file' });
  console.log('[Upload] Appt: ' + appointment_id + ', Location: ' + location_id + ', Duration: ' + duration_seconds + 's, File: ' + file.filename + ' (' + file.size + ' bytes)');
  const allRecs = db.getAllRecordings();
  let recording = allRecs.find(r => r.appointment_id === appointment_id);
  if (recording) {
    db.updateRecording(recording.recording_id, { audio_file_url: file.path, duration_seconds: parseInt(duration_seconds) || 0, processing_status: 'uploaded' });
  } else {
    recording = db.createRecording({ appointment_id: appointment_id || ('manual-' + Date.now()), location_id: location_id || 'unknown', duration_seconds: parseInt(duration_seconds) || 0, audio_file_url: file.path });
  }
  res.json({ success: true, recording_id: recording.recording_id, message: 'Audio received — processing started' });
  processRecording(recording.recording_id, file.path, location_id, appointment_id);
});

// ── AI Pipeline ───────────────────────────────────────────
async function processRecording(recording_id, audioFilePath, location_id, appointment_id) {
  const location = byLocationId[location_id];
  try {
    // Step 1: Transcribe
    console.log('[Pipeline] Starting transcription for ' + recording_id);
    db.updateRecording(recording_id, { processing_status: 'transcribing' });
    const transcript = await transcribeAudio(audioFilePath);
    db.updateRecording(recording_id, { transcript, processing_status: 'transcribed' });

    // Step 2: Score
    console.log('[Pipeline] Starting scoring for ' + recording_id);
    db.updateRecording(recording_id, { processing_status: 'scoring' });
    const scorecard = await scoreTranscript(transcript);
    const savedScorecard = db.createScorecard({ recording_id, scorecard });
    db.updateRecording(recording_id, { processing_status: 'scored' });

    // Step 3: Email
    const recording = db.getRecording(recording_id);
    if (location && recording) {
      await sendScorecardEmail(location, recording, savedScorecard);
      const threshold = parseInt(process.env.FLAG_SCORE_THRESHOLD) || 70;
      if (savedScorecard.total_score < threshold) {
        console.log('[Pipeline] Score ' + savedScorecard.total_score + ' below threshold — emailing Mike');
        const mikeLocation = Object.assign({}, location, { franchisee_name: location.franchisee_name + ' (' + location.franchise_name + ') ⚠️ FLAGGED', franchisee_email: process.env.MIKE_EMAIL || 'mike@airafitness.com' });
        await sendScorecardEmail(mikeLocation, recording, savedScorecard);
      }
    }
    console.log('[Pipeline] Complete for ' + recording_id + ' — score: ' + savedScorecard.total_score + '/100');
  } catch(err) {
    console.error('[Pipeline] Error for ' + recording_id + ':', err.message);
    db.updateRecording(recording_id, { processing_status: 'failed' });
  }
}

// ── Admin Dashboard ───────────────────────────────────────
app.get('/admin', (req, res) => {
  const recordings = db.getAllRecordings();
  const scorecards = db.getAllScorecards();
  const scorecardMap = {};
  scorecards.forEach(s => { scorecardMap[s.recording_id] = s; });
  const connectedTablets = Array.from(tabletConnections.keys());
  const rows = recordings.map(r => {
    const sc = scorecardMap[r.recording_id];
    const loc = byLocationId[r.location_id] || {};
    return '<tr><td>' + new Date(r.recorded_at).toLocaleString() + '</td><td>' + (loc.franchise_name || r.location_id) + '</td><td>' + r.appointment_id + '</td><td>' + Math.round(r.duration_seconds/60) + 'm ' + (r.duration_seconds%60) + 's</td><td><span class="status status-' + r.processing_status + '">' + r.processing_status + '</span></td><td>' + (sc ? '<strong style="color:' + (sc.total_score>=70?'#22c55e':'#ef4444') + '">' + sc.total_score + '/100</strong>' : '—') + '</td><td>' + (r.audio_file_url ? '<a href="/playback/' + r.recording_id + '">▶ Play</a>' : '—') + '</td></tr>';
  }).join('');
  res.send('<!DOCTYPE html><html><head><title>Aira Admin</title><meta charset="utf-8"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#0a0a0a;color:#f0f0f0;padding:32px}h1{color:#c8f060;font-size:24px;margin-bottom:4px}.sub{color:#666;font-size:13px;margin-bottom:32px}.cards{display:flex;gap:16px;margin-bottom:32px;flex-wrap:wrap}.card{background:#111;border:1px solid #222;border-radius:12px;padding:20px 24px;min-width:160px}.card-num{font-size:32px;font-weight:bold;color:#c8f060}.card-label{color:#666;font-size:12px;margin-top:4px;text-transform:uppercase;letter-spacing:1px}.tablets{background:#111;border:1px solid #222;border-radius:12px;padding:20px;margin-bottom:32px}.tablets h2{font-size:14px;color:#888;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px}.tablet-chip{display:inline-block;background:#1a2a0a;border:1px solid #4a7a20;color:#c8f060;padding:4px 12px;border-radius:20px;font-size:12px;margin-right:8px}.tablet-none{color:#555;font-size:13px}table{width:100%;border-collapse:collapse;background:#111;border-radius:12px;overflow:hidden}th{background:#1a1a1a;padding:12px 16px;text-align:left;font-size:11px;color:#666;letter-spacing:1px;text-transform:uppercase}td{padding:12px 16px;border-bottom:1px solid #1a1a1a;font-size:13px}tr:last-child td{border-bottom:none}a{color:#c8f060;text-decoration:none}.status{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:bold;text-transform:uppercase}.status-pending{background:#2a2a00;color:#ffcc00}.status-uploaded{background:#002a2a;color:#00cccc}.status-transcribing{background:#00002a;color:#6666ff}.status-transcribed{background:#002a00;color:#00cc66}.status-scoring{background:#2a1a00;color:#ff9900}.status-scored{background:#0a2a0a;color:#c8f060}.status-failed{background:#2a0000;color:#ff4444}</style></head><body><h1>Aira Fitness — Consult Recorder</h1><p class="sub">Admin Dashboard · Auto-refreshes every 30s</p><div class="cards"><div class="card"><div class="card-num">' + recordings.length + '</div><div class="card-label">Total Recordings</div></div><div class="card"><div class="card-num">' + scorecards.length + '</div><div class="card-label">Scorecards</div></div><div class="card"><div class="card-num">' + scorecards.filter(s=>s.total_score>=70).length + '</div><div class="card-label">Passing (≥70)</div></div><div class="card"><div class="card-num">' + scorecards.filter(s=>s.flagged_for_review).length + '</div><div class="card-label">Flagged</div></div><div class="card"><div class="card-num">' + connectedTablets.length + '</div><div class="card-label">Tablets Online</div></div></div><div class="tablets"><h2>Connected Tablets</h2>' + (connectedTablets.length>0?connectedTablets.map(id=>'<span class="tablet-chip">🟢 '+id+'</span>').join(''):'<span class="tablet-none">No tablets connected</span>') + '</div><table><thead><tr><th>Date</th><th>Location</th><th>Appt ID</th><th>Duration</th><th>Status</th><th>Score</th><th>Audio</th></tr></thead><tbody>' + (rows||'<tr><td colspan="7" style="text-align:center;color:#555;padding:40px">No recordings yet</td></tr>') + '</tbody></table><script>setTimeout(()=>location.reload(),30000);</script></body></html>');
});

app.get('/playback/:recording_id', (req, res) => {
  const rec = db.getRecording(req.params.recording_id);
  if (!rec || !rec.audio_file_url) return res.status(404).send('Not found');
  res.send('<!DOCTYPE html><html><head><title>Playback</title><style>body{background:#0a0a0a;color:#f0f0f0;font-family:Arial;padding:32px}h2{color:#c8f060}</style></head><body><h2>Recording Playback</h2><p style="color:#666;margin-bottom:16px">Appt: ' + rec.appointment_id + ' · ' + new Date(rec.recorded_at).toLocaleString() + '</p><audio controls style="width:100%;margin-bottom:24px"><source src="/audio/' + path.basename(rec.audio_file_url) + '"></audio>' + (rec.transcript?'<h3 style="color:#888;margin-bottom:8px">Transcript</h3><p style="line-height:1.7;color:#ccc">' + rec.transcript + '</p>':'<p style="color:#555">Transcript not yet available</p>') + '<p style="margin-top:16px"><a href="/admin" style="color:#c8f060">← Back to admin</a></p></body></html>');
});

app.use('/audio', express.static(UPLOAD_DIR));

app.get('/status', (req, res) => {
  res.json({ status: 'ok', tablets_connected: tabletConnections.size, tablets: Array.from(tabletConnections.keys()), recordings: db.getAllRecordings().length, scorecards: db.getAllScorecards().length, uptime_seconds: Math.round(process.uptime()) });
});

app.post('/test/trigger', (req, res) => {
  const { location_id, appointment_id } = req.body;
  const apptId = appointment_id || ('TEST-' + Date.now());
  const triggered = triggerTablet(location_id, apptId);
  const recording = db.createRecording({ appointment_id: apptId, location_id });
  res.json({ triggered, appointment_id: apptId, recording_id: recording.recording_id });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n  ╔════════════════════════════════════════╗');
  console.log('  ║  Aira Consult Recorder — Backend       ║');
  console.log('  ║  Running on port ' + PORT + '                   ║');
  console.log('  ╚════════════════════════════════════════╝\n');
  console.log('[Locations] Loaded ' + Object.keys(byLocationId).length + ' location(s)');
});
