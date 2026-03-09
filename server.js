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

