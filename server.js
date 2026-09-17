require('dotenv').config();

const fs = require('fs');
const https = require('https');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  '/socket.io',
  express.static(path.join(__dirname, 'node_modules/socket.io/client-dist'))
);
app.use(express.json());

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem')),
  },
  app
);

const io = new Server(server);

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

let dbReady = false;
pool.query('SELECT 1')
  .then(() => { dbReady = true; console.log(' PostgreSQL connecté'); })
  .catch((err) => console.warn('PostgreSQL indisponible :', err.message));

async function saveLog(entry) {
  if (!dbReady) return;
  try {
    await pool.query(
      `INSERT INTO connection_logs
       (session_id, peer_id, network_type, event_type, candidate_type, ice_state)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        entry.sessionId || null,
        entry.peerId || null,
        entry.networkType || null,
        entry.eventType || null,
        entry.candidateType || null,
        entry.iceState || null,
      ]
    );
  } catch (err) {
    console.error('Erreur insertion log:', err.message);
  }
}

const rooms = new Map();

io.on('connection', (socket) => {
  console.log('Socket connecté :', socket.id);

  socket.on('join', ({ roomId, networkType }) => {
    socket.data.roomId = roomId;
    socket.data.networkType = networkType;
    socket.join(roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, []);
    const others = rooms.get(roomId).filter((p) => p.socketId !== socket.id);
    socket.emit('peers-in-room', others.map((p) => p.socketId));

    rooms.get(roomId).push({ socketId: socket.id, networkType });
    socket.to(roomId).emit('peer-joined', { socketId: socket.id });

    saveLog({ sessionId: roomId, peerId: socket.id, networkType, eventType: 'join' });
  });

  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('ice-log', (entry) => {
    const enriched = {
      sessionId: socket.data.roomId,
      peerId: socket.id,
      networkType: socket.data.networkType,
      eventType: entry.eventType,
      candidateType: entry.candidateType,
      iceState: entry.iceState,
    };
    saveLog(enriched);
    io.to(socket.data.roomId).emit('log-broadcast', enriched);
  });

  socket.on('disconnect', () => {
    const { roomId } = socket.data;
    if (roomId && rooms.has(roomId)) {
      rooms.set(roomId, rooms.get(roomId).filter((p) => p.socketId !== socket.id));
      if (rooms.get(roomId).length === 0) rooms.delete(roomId);
      socket.to(roomId).emit('peer-left', { socketId: socket.id });
    }
    console.log('Socket déconnecté :', socket.id);
  });
});

app.get('/', (req, res) => {
  res.render('index', {
    turnHost: process.env.TURN_HOST || '',
    turnUser: process.env.TURN_USER || '',
    turnPass: process.env.TURN_PASS || '',
  });
});

app.get('/health', async (req, res) => {
  res.json({ ok: true, db: dbReady, rooms: rooms.size });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`\n https://localhost:${PORT}\n`);
});
