const express = require('express');
const cors = require('cors');
const http = require('http');
const net = require('net');
const path = require('path');
const Aedes = require('aedes');
const WebSocket = require('ws');
const websocketStream = require('websocket-stream');

const app = express();
app.use(cors());
app.use(express.json());

// Static files
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Create HTTP server to share between Express and MQTT over WebSocket
const httpServer = http.createServer(app);

// MQTT broker (Aedes)
const aedes = new Aedes();

// MQTT over WebSocket at /mqtt
const wss = new WebSocket.Server({ server: httpServer, path: '/mqtt' });
wss.on('connection', (ws) => {
  const stream = websocketStream(ws);
  aedes.handle(stream);
});

// Optional: MQTT TCP port (1883) for native MQTT clients
const tcpServer = net.createServer(aedes.handle);

// Voting session state
let currentSession = null; // { id, options: string[], endAt: ms, active: bool, votes: Map, tally: Object, timer }

function newTally(options) {
  const t = {};
  options.forEach((o) => { t[o] = 0; });
  return t;
}

function publish(topic, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  aedes.publish({ topic, payload, qos: 0, retain: false });
}

function endSession(reason = 'time_up') {
  if (!currentSession) return;
  if (currentSession.timer) {
    clearTimeout(currentSession.timer);
    currentSession.timer = null;
  }
  currentSession.active = false;
  publish('voting/session', {
    type: 'ended',
    sessionId: currentSession.id,
    reason,
    tally: currentSession.tally,
  });
}

// REST: start session
app.post('/api/start', (req, res) => {
  const { durationSeconds, options } = req.body || {};
  if (!Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: 'options must be an array with at least 2 entries' });
  }
  const dur = Number(durationSeconds);
  if (!Number.isFinite(dur) || dur <= 0) {
    return res.status(400).json({ error: 'durationSeconds must be a positive number' });
  }
  const id = 'sess_' + Date.now();
  const endAt = Date.now() + dur * 1000;
  currentSession = {
    id,
    options: options.map(String),
    endAt,
    active: true,
    votes: new Map(), // deviceId -> choice
    tally: newTally(options),
    timer: setTimeout(() => endSession('time_up'), dur * 1000),
  };

  publish('voting/session', {
    type: 'started',
    sessionId: id,
    options: currentSession.options,
    endAt,
  });

  return res.json({ ok: true, sessionId: id, endAt, options: currentSession.options });
});

// REST: status
app.get('/api/status', (req, res) => {
  if (!currentSession) return res.json({ active: false });
  const { id, options, endAt, active, tally } = currentSession;
  return res.json({ sessionId: id, options, endAt, active, tally });
});

// REST: results
app.get('/api/results', (req, res) => {
  if (!currentSession) return res.json({ active: false, tally: {} });
  const { id, tally, active } = currentSession;
  return res.json({ sessionId: id, active, tally });
});

// Handle incoming votes via MQTT topic voting/vote
// payload: { sessionId, deviceId, choice }
aedes.subscribe('voting/vote', (packet, cb) => {
  try {
    const data = JSON.parse(packet.payload.toString());
    const { sessionId, deviceId, choice } = data || {};
    if (!currentSession || !currentSession.active) return cb();
    if (sessionId !== currentSession.id) return cb();
    if (!deviceId || typeof deviceId !== 'string') return cb();
    if (!currentSession.options.includes(choice)) return cb();

    if (!currentSession.votes.has(deviceId)) {
      currentSession.votes.set(deviceId, choice);
      currentSession.tally[choice] = (currentSession.tally[choice] || 0) + 1;
      publish('voting/tally', {
        sessionId: currentSession.id,
        tally: currentSession.tally,
        totalVotes: currentSession.votes.size,
      });
    }
  } catch (e) {
    // ignore malformed
  } finally {
    if (cb) cb();
  }
});

// Graceful shutdown
function shutdown() {
  try { endSession('shutdown'); } catch {}
  try { tcpServer.close(); } catch {}
  try { wss.close(); } catch {}
  try { httpServer.close(); } catch {}
  try { aedes.close(); } catch {}
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start servers
const HTTP_PORT = process.env.PORT || 3000;
const TCP_PORT = process.env.MQTT_PORT || 1883;
httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP + WS server listening on http://localhost:${HTTP_PORT}`);
  console.log(`WebSocket MQTT path: /mqtt`);
});

tcpServer.listen(TCP_PORT, () => {
  console.log(`MQTT TCP broker listening on port ${TCP_PORT}`);
});
