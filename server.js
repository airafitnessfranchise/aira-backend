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
const db = require('./b');
const { transcribeAudio, scoreTranscript } = require('./ai');
const { sendScorecardEmail } = require('./email');
const { uploadToR2, getPresignedUrl } = require('./storage');

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

const tabletConnections = new Map();

wss.on('connection', (ws, req) => {
  console.log('[WS] New connection from ' + req.socket.remoteAddress);
  let registeredLocationId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'register') {
        const loc = byLocationId[msg.location_id];
        if (!loc) {
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown location: ' + msg.location_id }));
          return;
        }
        registeredLocationId = msg.location_id;
        tabletConnections.set(msg.location_id, ws);
        ws.send(JSON.stringify({ type: 'registered', status: 'ok', location: loc.franchise_name, message: 'Registered as ' + loc.franchise_name }));
        console.log('[WS] Tablet registered: ' + msg.location_id);
      }
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch(e) { console.error('[WS] Parse error:', e.message); }
  });

  ws.on('close', () => {
    if (registeredLocationId) {
      tabletConnections.delete(registeredLocationId);
      console.log('[WS] Tablet disconnected: ' + registeredLocationId);
    }
  });

  ws.on('error', (err) => console.error('[WS] Error:', err.message));
  ws.send(JSON.stringify({ type: 'connected', message: 'Connected to Aira backend' }));
});

function triggerTablet(location_id, appointment_id, contact_name) {
  const ws = tabletConnections.get(location_id);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[WS] No active tablet for: ' + location_id);
    return false;
  }
  ws.send(JSON.stringify({ action: 'start', appt_id: appointment_id, location: location_id, contact_name: contact_name || 'Walk-in' }));
  console.log('[WS] Triggered tablet at ' + location_id);
  return true;
}

app.post('/webhook/ghl', (req, res) => {
  console.log('[GHL] Webhook received:', JSON.stringify(req.body, null, 2));
  const body = req.body;
  const calendarId = body.calendar_id || body.calendarId || (body.calendar ? body.calendar.id : null) || (body.appointment ? body.appointment.calendar_id : null) || null;
  const appointmentId = body.id || body.appointment_id || body.appointmentId || (body.appointment ? body.appointment.id : null) || uuidv4();
  const contactName = body.contact_name || body.contactName || (body.contact ? body.contact.name : null) || 'Walk-in';
  console.log('[GHL] Calendar: ' + calendarId + ', Contact: ' + contactName);

  const location = calendarId ? byCalendarId[calendarId] : null;
  if (!location) {
    console.warn('[GHL] No location for calendar_id: ' + calendarId);
    return res.json({ success: false, message: 'No location mapped to ' + calendarId });
  }

  const recording = db.createRecording({ appointment_id: appointmentId, location_id: location.location_id, contact_name: contactName });
  const triggered = triggerTablet(location.location_id, appointmentId, contactName);
  res.json({ success: true, location: location.franchise_name, appointment_id: appointmentId, recording_id: recording.recording_id, tablet_triggered: triggered });
});

app.post('/upload/recording', upload.single('audio_file'), async (req, res) => {
  console.log('[Upload] Audio file received');
  const appointment_id = req.body.appointment_id;
  const location_id = req.body.location_id;
  const duration_seconds = req.body.duration_seconds;
  const contact_name = req.body.contact_name;
  const file = req.file;

  if (!file) return res.status(400).json({ success: false, message: 'No audio file' });
  console.log('[Upload] Appt: ' + appointment_id + ', Duration: ' + duration_seconds + 's');

  const allRecs = db.getAllRecordings();
  let recording = allRecs.find(function(r) { return r.appointment_id === appointment_id; });

  if (recording) {
    db.updateRecording(recording.recording_id, {
      audio_file_url: file.path,
      duration_seconds: parseInt(duration_seconds) || 0,
      processing_status: 'uploaded',
      contact_name: contact_name || recording.contact_name || 'Walk-in'
    });
  } else {
    recording = db.createRecording({
      appointment_id: appointment_id || ('manual-' + Date.now()),
      location_id: location_id || 'unknown',
      duration_seconds: parseInt(duration_seconds) || 0,
      audio_file_url: file.path,
      contact_name: contact_name || 'Walk-in'
    });
  }

  res.json({ success: true, recording_id: recording.recording_id, message: 'Audio received' });
  processRecording(recording.recording_id, file.path, location_id, appointment_id);
});

async function processRecording(recording_id, audioFilePath, location_id, appointment_id) {
  const location = byLocationId[location_id] || {
    location_id: location_id || 'unknown',
    franchise_name: 'Walk-in / Unknown Location',
    franchisee_name: 'Franchisee',
    franchisee_email: process.env.MIKE_EMAIL || 'mikebell@airafitness.com'
  };
  try {
    // --- Upload to R2 ---
    console.log('[Pipeline] Uploading to R2: ' + recording_id);
    const r2Key = await uploadToR2(audioFilePath, recording_id);
    if (r2Key) {
      db.updateRecording(recording_id, { r2_key: r2Key });
      console.log('[Pipeline] R2 key stored: ' + r2Key);
    }

    // --- Transcribe ---
    console.log('[Pipeline] Transcribing ' + recording_id);
    db.updateRecording(recording_id, { processing_status: 'transcribing' });
    const transcript = await transcribeAudio(audioFilePath);
    db.updateRecording(recording_id, { transcript: transcript, processing_status: 'transcribed' });

    // --- Score ---
    console.log('[Pipeline] Scoring ' + recording_id);
    db.updateRecording(recording_id, { processing_status: 'scoring' });
    const scorecard = await scoreTranscript(transcript);
    const savedScorecard = db.createScorecard({ recording_id: recording_id, scorecard: scorecard });
    db.updateRecording(recording_id, { processing_status: 'scored' });

    // --- Generate presigned URL (7-day link) ---
    const audioUrl = r2Key ? await getPresignedUrl(r2Key) : null;
    if (audioUrl) console.log('[Pipeline] Presigned URL generated for ' + recording_id);

    // --- Email ---
    const recording = db.getRecording(recording_id);
    if (location && recording) {
      await sendScorecardEmail(location, recording, savedScorecard, audioUrl);

      const threshold = parseInt(process.env.FLAG_SCORE_THRESHOLD) || 70;
      if (savedScorecard.total_score < threshold) {
        console.log('[Pipeline] Score ' + savedScorecard.total_score + ' below threshold — flagged (Mike notified via email CC)');
      }
    }

    console.log('[Pipeline] Complete: ' + recording_id + ' score=' + savedScorecard.total_score);
  } catch(err) {
    console.error('[Pipeline] Error:', err.message);
    db.updateRecording(recording_id, { processing_status: 'failed' });
  }
}

app.get('/admin', (req, res) => {
  const recordings = db.getAllRecordings();
  const scorecards = db.getAllScorecards();
  const scorecardMap = {};
  scorecards.forEach(function(s) { scorecardMap[s.recording_id] = s; });
  const connectedTablets = Array.from(tabletConnections.keys());

  const rows = recordings.map(function(r) {
    const sc = scorecardMap[r.recording_id];
    const loc = byLocationId[r.location_id] || {};
    const name = r.contact_name || r.appointment_id;
    return '<tr><td>' + new Date(r.recorded_at).toLocaleString() + '</td><td>' + (loc.franchise_name || r.location_id) + '</td><td>' + name + '</td><td>' + Math.round(r.duration_seconds/60) + 'm ' + (r.duration_seconds%60) + 's</td><td><span class="status status-' + r.processing_status + '">' + r.processing_status + '</span></td><td>' + (sc ? '<strong style="color:' + (sc.total_score>=70?'#22c55e':'#ef4444') + '">' + sc.total_score + '/100</strong>' : '-') + '</td><td>' + (r.audio_file_url ? '<a href="/playback/' + r.recording_id + '">Play</a>' : '-') + '</td></tr>';
  }).join('');

  res.send('<!DOCTYPE html><html><head><title>Aira Admin</title><meta charset="utf-8"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#0a0a0a;color:#f0f0f0;padding:32px}h1{color:#c8f060;font-size:24px;margin-bottom:4px}.sub{color:#666;font-size:13px;margin-bottom:32px}.cards{display:flex;gap:16px;margin-bottom:32px;flex-wrap:wrap}.card{background:#111;border:1px solid #222;border-radius:12px;padding:20px 24px;min-width:160px}.card-num{font-size:32px;font-weight:bold;color:#c8f060}.card-label{color:#666;font-size:12px;margin-top:4px;text-transform:uppercase;letter-spacing:1px}table{width:100%;border-collapse:collapse;background:#111;border-radius:12px;overflow:hidden}th{background:#1a1a1a;padding:12px 16px;text-align:left;font-size:11px;color:#666;letter-spacing:1px;text-transform:uppercase}td{padding:12px 16px;border-bottom:1px solid #1a1a1a;font-size:13px}tr:last-child td{border-bottom:none}a{color:#c8f060;text-decoration:none}.status{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:bold;text-transform:uppercase}.status-pending,.status-uploaded{background:#2a2a00;color:#ffcc00}.status-transcribing,.status-scoring{background:#00002a;color:#6666ff}.status-transcribed{background:#002a00;color:#00cc66}.status-scored{background:#0a2a0a;color:#c8f060}.status-failed{background:#2a0000;color:#ff4444}</style></head><body><h1>Aira Fitness - Consult Recorder</h1><p class="sub">Admin Dashboard</p><div class="cards"><div class="card"><div class="card-num">' + recordings.length + '</div><div class="card-label">Recordings</div></div><div class="card"><div class="card-num">' + scorecards.length + '</div><div class="card-label">Scorecards</div></div><div class="card"><div class="card-num">' + connectedTablets.length + '</div><div class="card-label">Tablets Online</div></div></div><table><thead><tr><th>Date</th><th>Location</th><th>Prospect</th><th>Duration</th><th>Status</th><th>Score</th><th>Audio</th></tr></thead><tbody>' + (rows||'<tr><td colspan="7" style="text-align:center;color:#555;padding:40px">No recordings yet</td></tr>') + '</tbody></table><script>setTimeout(function(){location.reload()},30000);<\/script></body></html>');
});

app.get('/playback/:recording_id', (req, res) => {
  const rec = db.getRecording(req.params.recording_id);
  if (!rec || !rec.audio_file_url) return res.status(404).send('Not found');
  const name = rec.contact_name || rec.appointment_id;
  res.send('<!DOCTYPE html><html><head><title>Playback</title><style>body{background:#0a0a0a;color:#f0f0f0;font-family:Arial;padding:32px}h2{color:#c8f060}</style></head><body><h2>Recording: ' + name + '</h2><p style="color:#666;margin-bottom:16px">' + new Date(rec.recorded_at).toLocaleString() + '</p><audio controls style="width:100%;margin-bottom:24px"><source src="/audio/' + path.basename(rec.audio_file_url) + '"></audio>' + (rec.transcript ? '<h3 style="color:#888;margin-bottom:8px">Transcript</h3><p style="line-height:1.7;color:#ccc">' + rec.transcript + '</p>' : '<p style="color:#555">No transcript yet</p>') + '<p style="margin-top:16px"><a href="/admin" style="color:#c8f060">Back to admin</a></p></body></html>');
});

app.use('/audio', express.static(UPLOAD_DIR));

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

app.post('/test/trigger', (req, res) => {
  const location_id = req.body.location_id;
  const apptId = req.body.appointment_id || ('TEST-' + Date.now());
  const triggered = triggerTablet(location_id, apptId);
  const recording = db.createRecording({ appointment_id: apptId, location_id: location_id });
  res.json({ triggered: triggered, appointment_id: apptId, recording_id: recording.recording_id });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Aira backend running on port ' + PORT);
  console.log('[Locations] ' + Object.keys(byLocationId).length + ' location(s) loaded');
});
