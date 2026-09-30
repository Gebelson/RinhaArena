// Blast Arena server: static file host + real-time multiplayer, zero npm
// dependencies. The WebSocket layer (RFC 6455 handshake + frame codec) is
// implemented by hand on top of node:http so `npm start` is all you need.
//
// Each room runs its own GameHost — the *same* sim code the browser uses for
// solo play. Humans joining replace bots; leaving humans are replaced by
// bots; empty rooms are torn down after a grace period.
//
//   npm start          -> http://localhost:8090 (game + ws on one port)
//   PORT=3000 npm start

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { GameHost } from '../src/game/host.js';
import { packState } from '../src/net/protocol.js';
import { CONFIG } from '../src/core/config.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 8090;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.webmanifest': 'application/manifest+json',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
};

// ------------------------------------------------------------ static files
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/api/rooms')) {
    const list = [];
    for (const [code, r] of rooms) {
      const modeId = r.host?.modeId || r.modeId || 'ctf';
      const levelId = r.host?.levelId || r.levelId || 'skyhaven';
      const teamLimits = r.teamLimits || (modeId === 'ffa' ? { ffa: 6 } : { red: 2, blue: 2 });
      const maxPlayers = modeId === 'ffa' ? (teamLimits.ffa || 6) : ((teamLimits.red || 2) + (teamLimits.blue || 2));
      const humanCount = r.clients.size;
      list.push({
        code: r.code,
        name: r.name || `Sala ${r.code}`,
        modeId,
        levelId,
        isPrivate: !!r.isPrivate,
        playersCount: humanCount,
        maxPlayers,
        teamLimits,
        respawnTime: r.respawnTime ?? 5,
        friendlyFire: !!r.friendlyFire,
      });
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.end(JSON.stringify(list));
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/api/rooms')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        let code = (data.code || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 12);
        if (!code) {
          code = Math.random().toString(36).substring(2, 8);
        }
        const modeId = data.modeId || 'ctf';
        const levelId = data.levelId || 'skyhaven';
        const redSize = Math.max(1, Math.min(5, Number(data.redSize) || 2));
        const blueSize = Math.max(1, Math.min(5, Number(data.blueSize) || 2));
        const ffaSize = Math.max(2, Math.min(10, Number(data.ffaSize) || 6));
        const teamLimits = modeId === 'ffa' ? { ffa: ffaSize } : { red: redSize, blue: blueSize };
        const respawnTime = Math.max(1, Math.min(8, Number(data.respawnTime) || 5));
        const friendlyFire = !!data.friendlyFire;
        const name = (data.name || '').trim().slice(0, 24) || `Sala ${code}`;
        const password = data.password ? String(data.password).slice(0, 20) : null;

        const room = getRoom(code, {
          levelId,
          modeId,
          teamLimits,
          respawnTime,
          friendlyFire,
          name,
          password,
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          code: room.code,
          name: room.name,
          isPrivate: room.isPrivate,
        }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT)) throw new Error('traversal');
    const ext = path.extname(filePath);
    const contentType = MIME[ext] ?? 'application/octet-stream';
    const data = await readFile(filePath);

    // Support HTTP Range requests (crucial for smooth audio streaming and seeking)
    const range = req.headers.range;
    if (range && ext === '.mp3') {
      const total = data.length;
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunk = data.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunk.length,
        'Content-Type': contentType,
      });
      res.end(chunk);
      return;
    }

    res.writeHead(200, {
      'content-type': contentType,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

// --------------------------------------------------------- websocket codec
function wsAccept(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Pulls complete frames out of conn.buffer; calls handlers for text frames.
function parseFrames(conn, onText, onClose) {
  for (;;) {
    const buf = conn.buffer;
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) return;
    let payload = buf.subarray(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = buf.subarray(off, off + 4);
      payload = Buffer.from(payload); // unmask a copy
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    conn.buffer = buf.subarray(off + maskLen + len);
    if (opcode === 0x1) onText(payload.toString('utf8'));
    else if (opcode === 0x8) { onClose(); return; }
    else if (opcode === 0x9) { // ping -> pong
      try { conn.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } catch { /* gone */ }
    }
  }
}

// ------------------------------------------------------------------- rooms
const rooms = new Map();

function getRoom(code, options = {}) {
  let room = rooms.get(code);
  if (room) return room;

  if (typeof options === 'string') {
    options = { levelId: options };
  } else if (!options || typeof options !== 'object') {
    options = {};
  }

  const reqLevel = options.levelId;
  const modeId = options.modeId || 'ctf';
  const teamLimits = options.teamLimits || null;
  const respawnTime = options.respawnTime != null ? options.respawnTime : null;
  const friendlyFire = options.friendlyFire != null ? options.friendlyFire : null;

  const host = new GameHost({
    levelId: reqLevel || 'skyhaven',
    modeId,
    teamLimits,
    respawnTime,
    friendlyFire,
  });
  host.fillBots();
  room = {
    code,
    name: options.name || `Sala ${code}`,
    password: options.password ? String(options.password) : null,
    isPrivate: !!options.password,
    teamLimits: host.teamLimits,
    respawnTime: host.config.player.respawnTime,
    friendlyFire: host.config.rules.friendlyFire,
    host,
    clients: new Set(),
    emptySince: Date.now(),
    tickTimer: null,
    snapTimer: null,
    lastStep: Date.now(),
  };
  room.tickTimer = setInterval(() => {
    const now = Date.now();
    host.step((now - room.lastStep) / 1000);
    room.lastStep = now;
    // tear down rooms nobody has used for a minute
    if (room.clients.size === 0 && now - room.emptySince > 60_000) destroyRoom(room);
  }, 1000 / CONFIG.tickRate);
  room.snapTimer = setInterval(() => {
    if (room.clients.size === 0) return;
    const msg = encodeFrame(JSON.stringify({
      t: 'snap',
      s: packState(host.sim.state),
      e: host.drainEvents(),
    }));
    for (const c of room.clients) {
      try { c.socket.write(msg); } catch { /* dropped; close event cleans up */ }
    }
  }, 1000 / CONFIG.snapshotRate);

  rooms.set(code, room);
  console.log(`[room ${code}] created (${modeId}, ${host.levelId})`);
  return room;
}

function destroyRoom(room) {
  clearInterval(room.tickTimer);
  clearInterval(room.snapTimer);
  rooms.delete(room.code);
  console.log(`[room ${room.code}] destroyed`);
}

function leaveRoom(conn) {
  const room = conn.room;
  if (!room) return;
  room.clients.delete(conn);
  if (conn.playerId) room.host.replaceWithBot(conn.playerId);
  if (room.clients.size === 0) room.emptySince = Date.now();
  console.log(`[room ${room.code}] ${conn.playerId ?? '?'} left (${room.clients.size} humans)`);
  conn.room = null;
}

// --------------------------------------------------------------- upgrades
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const url = new URL(req.url, 'http://x');
  if (!key || url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const conn = {
    socket,
    buffer: Buffer.alloc(0),
    room: null,
    playerId: null,
  };
  const roomCode = (url.searchParams.get('room') || 'main').slice(0, 12) || 'main';

  const close = () => {
    leaveRoom(conn);
    socket.destroy();
  };

  socket.on('data', (chunk) => {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    if (conn.buffer.length > 64 * 1024) return close(); // input flood guard
    parseFrames(conn, (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.t === 'join' && !conn.playerId) {
        const reqLevel = url.searchParams.get('level');
        const room = getRoom(roomCode, reqLevel);
        const pass = msg.password || url.searchParams.get('password');
        if (room.isPrivate && room.password && room.password !== pass) {
          socket.write(encodeFrame(JSON.stringify({
            t: 'error',
            reason: 'Senha incorreta!',
          })));
          return close();
        }

        const maxCap = room.host.modeId === 'ffa'
          ? (room.host.teamLimits?.ffa ?? 6)
          : ((room.host.teamLimits?.red ?? 2) + (room.host.teamLimits?.blue ?? 2));
        if (room.clients.size >= maxCap) {
          socket.write(encodeFrame(JSON.stringify({
            t: 'error',
            reason: 'A sala está cheia!',
          })));
          return close();
        }

        conn.room = room;
        conn.playerId = room.host.addHuman({
          name: String(msg.name ?? 'Player').slice(0, 12),
          team: msg.team || url.searchParams.get('team') || null,
          cos: {
            hat: String(msg.cos?.hat ?? 'none').slice(0, 16),
            skin: String(msg.cos?.skin ?? '#ffd29c').slice(0, 9),
          },
        });
        room.clients.add(conn);
        socket.write(encodeFrame(JSON.stringify({
          t: 'welcome',
          id: conn.playerId,
          levelId: room.host.levelId,
          modeId: room.host.modeId,
          teamLimits: room.host.teamLimits,
        })));
        console.log(`[room ${room.code}] ${conn.playerId} joined as "${msg.name}" (${room.clients.size} humans)`);
      } else if (msg.t === 'input' && conn.room && conn.playerId) {
        const i = msg.i ?? {};
        conn.room.host.setInput(conn.playerId, {
          mx: +i.mx || 0, mz: +i.mz || 0,
          ax: +i.ax || 0, az: +i.az || 0, ad: +i.ad || 7,
          punch: !!i.punch, grab: !!i.grab, dash: !!i.dash, jump: !!i.jump,
          throw: !!i.throw, aiming: !!i.aiming,
        });
      }
    }, close);
  });
  socket.on('close', () => leaveRoom(conn));
  socket.on('error', () => close());
});

server.listen(PORT, () => {
  console.log(`Blast Arena serving on http://localhost:${PORT} (rooms via ws://…/ws)`);
});
