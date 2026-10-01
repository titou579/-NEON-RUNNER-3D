const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data', 'db.json');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

let db = { users: {}, tokens: {}, globalChat: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) {}
  }, 400);
}

const hashPass = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const genToken  = () => crypto.randomBytes(24).toString('hex');
function genCode(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return name.slice(0, 4).toUpperCase() + (h % 100);
}
function lvlFromXp(xp) { return 1 + Math.floor(Math.sqrt(xp / 200)); }

function pub(u) {
  return {
    name: u.name, code: u.code,
    coins: u.coins, xp: u.xp, level: lvlFromXp(u.xp),
    best: u.best, games: u.games, crystals: u.crystals, distance: u.distance,
    inventory: u.inventory, equipped: u.equipped, friends: u.friends,
    ghost: u.ghost || null
  };
}
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const name = db.tokens[t];
  if (!name || !db.users[name]) return res.status(401).json({ error: 'Non authentifié' });
  req.user = db.users[name];
  req.token = t;
  next();
}

/* ═══════════ REST ═══════════ */

app.post('/api/register', (req, res) => {
  const { name, pass } = req.body || {};
  if (!name || name.length < 3 || name.length > 14)
    return res.status(400).json({ error: 'Pseudo : 3 à 14 caractères' });
  if (!pass || pass.length < 3)
    return res.status(400).json({ error: 'Mot de passe : 3 caractères min' });
  const k = name.toLowerCase();
  if (db.users[k]) return res.status(400).json({ error: 'Ce pseudo existe déjà' });
  const salt = crypto.randomBytes(8).toString('hex');
  const u = {
    name, salt, pass: hashPass(pass, salt), code: genCode(name),
    coins: 200, xp: 0, best: 0, games: 0, crystals: 0, distance: 0,
    inventory: ['skin_cyan', 'trail_none', 'bg_default'],
    equipped: { skin: 'skin_cyan', trail: 'trail_none', bg: 'bg_default' },
    friends: [], ghost: null, createdAt: Date.now()
  };
  db.users[k] = u;
  const t = genToken(); db.tokens[t] = k;
  save();
  res.json({ token: t, user: pub(u) });
});

app.post('/api/login', (req, res) => {
  const { name, pass } = req.body || {};
  if (!name || !pass) return res.status(400).json({ error: 'Champs requis' });
  const u = db.users[name.toLowerCase()];
  if (!u || u.pass !== hashPass(pass, u.salt))
    return res.status(400).json({ error: 'Identifiants incorrects' });
  const t = genToken(); db.tokens[t] = name.toLowerCase();
  save();
  res.json({ token: t, user: pub(u) });
});

app.post('/api/logout', auth, (req, res) => {
  delete db.tokens[req.token]; save();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: pub(req.user) }));

app.post('/api/save', auth, (req, res) => {
  const u = req.user;
  const { score = 0, crystals = 0, distance = 0, ghost } = req.body || {};
  const coinsEarned = Math.floor(score / 20) + crystals * 3;
  const xpEarned    = Math.floor(score / 10) + crystals * 2;
  u.coins += coinsEarned;
  u.xp += xpEarned;
  u.crystals += crystals;
  u.games += 1;
  u.distance += distance;
  if (score > u.best) {
    u.best = score;
    if (Array.isArray(ghost) && ghost.length > 5) u.ghost = ghost;
  }
  save();
  res.json({ user: pub(u), coinsEarned, xpEarned });
});

app.post('/api/shop', auth, (req, res) => {
  const u = req.user;
  const { itemId, cat, price = 0 } = req.body || {};
  if (!itemId || !cat) return res.status(400).json({ error: 'Données manquantes' });
  if (!u.inventory.includes(itemId)) {
    if (u.coins < price) return res.status(400).json({ error: 'Pièces insuffisantes' });
    u.coins -= price;
    u.inventory.push(itemId);
  }
  u.equipped[cat] = itemId;
  save();
  res.json({ user: pub(u) });
});

app.get('/api/leaderboard', (req, res) => {
  const arr = Object.values(db.users).map(u => ({
    name: u.name, code: u.code, best: u.best, level: lvlFromXp(u.xp)
  })).sort((a, b) => b.best - a.best).slice(0, 30);
  res.json(arr);
});

/* ═══════════ SOCKET.IO ═══════════ */

const online = new Map();       // name → socket.id
const races  = new Map();       // roomId → { seed, host, guest }

io.use((socket, next) => {
  const t = socket.handshake.auth && socket.handshake.auth.token;
  const name = db.tokens[t];
  if (!name || !db.users[name]) return next(new Error('auth'));
  socket.userName = name;
  next();
});

io.on('connection', (socket) => {
  const u = db.users[socket.userName];
  socket.join('u:' + socket.userName);
  online.set(socket.userName, socket.id);
  io.emit('presence', { name: u.name, online: true });

  /* ----- Chat global ----- */
  socket.on('chat:global', (text) => {
    if (typeof text !== 'string' || text.length > 200) return;
    const msg = { from: u.name, text, t: Date.now() };
    db.globalChat.push(msg);
    if (db.globalChat.length > 200) db.globalChat.shift();
    save();
    io.emit('chat:global', msg);
  });

  /* ----- Chat privé ----- */
  socket.on('chat:dm', ({ to, text }) => {
    if (typeof text !== 'string' || text.length > 300) return;
    const target = Object.values(db.users).find(x => x.name === to || x.code === to);
    if (!target) return;
    const msg = { from: u.name, to: target.name, text, t: Date.now() };
    io.to('u:' + target.name.toLowerCase()).emit('chat:dm', msg);
    socket.emit('chat:dm', msg);
  });

  /* ----- Amis ----- */
  socket.on('friends:request', (code) => {
    const target = Object.values(db.users).find(x => x.code === code);
    if (!target || target.name === u.name)
      return socket.emit('friends:error', 'Code introuvable');
    if (!u.friends.includes(target.code)) u.friends.push(target.code);
    if (!target.friends.includes(u.code)) target.friends.push(u.code);
    save();
    io.to('u:' + target.name.toLowerCase()).emit('friends:update');
    socket.emit('friends:update');
  });

  socket.on('friends:list', () => {
    const list = u.friends.map(code => {
      const f = Object.values(db.users).find(x => x.code === code);
      if (!f) return null;
      return {
        name: f.name, code: f.code, best: f.best,
        level: lvlFromXp(f.xp),
        online: online.has(f.name.toLowerCase())
      };
    }).filter(Boolean);
    socket.emit('friends:list', list);
  });

  /* ----- Course 1v1 temps réel ----- */
  socket.on('race:create', () => {
    const roomId = crypto.randomBytes(3).toString('hex').toUpperCase();
    const seed = Math.floor(Math.random() * 1e9);
    races.set(roomId, { seed, host: u.name, guest: null });
    socket.join('race:' + roomId);
    socket.emit('race:created', { roomId, seed });
  });

  socket.on('race:join', (roomId) => {
    const r = races.get(roomId);
    if (!r) return socket.emit('race:error', 'Salle introuvable');
    if (r.guest) return socket.emit('race:error', 'Salle pleine');
    r.guest = u.name;
    socket.join('race:' + roomId);
    io.to('race:' + roomId).emit('race:start', {
      roomId, seed: r.seed, players: [r.host, r.guest]
    });
  });

  socket.on('race:update', ({ roomId, x, score, lives }) => {
    socket.to('race:' + roomId).emit('race:opponent', {
      name: u.name, x, score, lives
    });
  });

  socket.on('race:finished', ({ roomId, score }) => {
    io.to('race:' + roomId).emit('race:finished', { name: u.name, score });
    races.delete(roomId);
  });

  socket.on('disconnect', () => {
    online.delete(socket.userName);
    io.emit('presence', { name: u.name, online: false });
  });
});

server.listen(PORT, () => console.log('🎮 Neon Runner sur port ' + PORT));
