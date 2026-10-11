const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { CLIENT_ID, BASE_URL, SESSION_SECRET, PORT = 3000 } = process.env;
if (!CLIENT_ID || !BASE_URL || !SESSION_SECRET) {
  console.error('Missing environment variables. Set CLIENT_ID, BASE_URL and SESSION_SECRET (see README.md).');
  process.exit(1);
}
const REDIRECT = BASE_URL.replace(/\/$/, '') + '/auth/callback';

const app = express();
app.set('trust proxy', 1);
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: BASE_URL.startsWith('https'), maxAge: 7 * 24 * 3600 * 1000 }
}));

// ---- mods: Roblox usernames allowed to use the mod menu (set ADMINS=name1,name2) ----
const ADMIN_NAMES = (process.env.ADMINS || 'rxphina10,10tistt,crashhrr,Floppy_467,iv4rsen01').split(',').map(x => x.trim()).filter(Boolean);
// Usernames can be changed, so each mod's name is turned into their permanent Roblox user id (and refreshed every 6 hours)
const adminIds = new Map(); // lowercase mod name -> Roblox user id
async function resolveAdmins() {
  try {
    const r = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: ADMIN_NAMES, excludeBannedUsers: true })
    }).then(x => x.json());
    (r.data || []).forEach(u => adminIds.set(String(u.requestedUsername).toLowerCase(), String(u.id)));
    console.log('Mod accounts: ' + ADMIN_NAMES.map(n => n + (adminIds.has(n.toLowerCase()) ? '' : ' (not found yet)')).join(', '));
  } catch (e) { console.error('Could not look up mod accounts yet; matching by username until it works.'); }
}
resolveAdmins();
setInterval(resolveAdmins, 6 * 3600e3).unref();
const isAdmin = req => {
  const u = req.session.user;
  if (!u) return false;
  const id = String(u.id), n = String(u.name).toLowerCase();
  if ([...adminIds.values()].includes(id)) return true;
  return ADMIN_NAMES.some(a => a.toLowerCase() === n && !adminIds.has(a.toLowerCase()));
};
const needAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(403).json({ error: 'Mods only. Sign in with a mod account.' });
app.use(express.json({ limit: '50kb' }));

// players.json is re-read on every request, so edits show up without a restart
// older players.json files (with 4/5/6/5/8/8 sub-stats) are upgraded on the fly: removed stats are dropped
const OLD_COUNTS = [4, 5, 6, 5, 8, 8];
const KEEP = [[1, 2], [0, 1, 4], null, [0, 1, 3, 4], [0, 2, 3, 4, 5], null];
function migrate(p) {
  if (Array.isArray(p.cats)) p.cats = p.cats.map((c, i) => (KEEP[i] && Array.isArray(c[1]) && c[1].length === OLD_COUNTS[i]) ? [c[0], KEEP[i].map(k => c[1][k])] : c);
  if (!Array.isArray(p.trophies)) p.trophies = [];
  return p;
}
const loadPlayers = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'players.json'), 'utf8')).map(migrate);
const findPlayer = n => loadPlayers().find(p => p.name.toLowerCase() === String(n).toLowerCase());

// ---- Roblox avatar headshots (cached for 1 hour) ----
const avatarCache = new Map();
async function avatarFor(name) {
  const key = name.toLowerCase();
  const hit = avatarCache.get(key);
  if (hit && Date.now() - hit.t < 3600e3) return hit.url;
  let url = null;
  try {
    const u = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [name], excludeBannedUsers: true })
    }).then(r => r.json());
    const id = u.data && u.data[0] && u.data[0].id;
    if (id) {
      const t = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`).then(r => r.json());
      url = (t.data && t.data[0] && t.data[0].imageUrl) || null;
    }
  } catch (e) { /* fall back to the blocky placeholder face */ }
  avatarCache.set(key, { url, t: Date.now() });
  return url;
}

// headshot of the signed-in user, looked up by their Roblox user id
const idCache = new Map();
async function headshotById(id) {
  const hit = idCache.get(id);
  if (hit && Date.now() - hit.t < 3600e3) return hit.url;
  let url = null;
  try {
    const t = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(id)}&size=150x150&format=Png&isCircular=false`).then(r => r.json());
    url = (t.data && t.data[0] && t.data[0].imageUrl) || null;
  } catch (e) { /* the button falls back to the first letter */ }
  idCache.set(id, { url, t: Date.now() });
  return url;
}

async function withAvatars() {
  const list = loadPlayers();
  const avatars = await Promise.all(list.map(p => avatarFor(p.name)));
  return list.map((p, i) => ({ ...p, avatar: avatars[i] }));
}
app.get('/api/players', async (req, res) => res.json(await withAvatars()));

app.get('/api/me', async (req, res) => {
  const u = req.session.user;
  if (!u) return res.json({});
  const p = findPlayer(u.name);
  res.json({ name: p ? p.name : u.name, inLeague: !!p, isAdmin: isAdmin(req), avatar: await headshotById(u.id) });
});

// ---- "Sign in with Roblox" (OAuth 2.0 authorization code flow) ----
app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  req.session.oauth = { state, verifier };
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: 'openid profile', response_type: 'code', state,
    code_challenge: challenge, code_challenge_method: 'S256'
  });
  res.redirect('https://apis.roblox.com/oauth/v1/authorize?' + q);
});

app.get('/auth/callback', async (req, res) => {
  const o = req.session.oauth;
  delete req.session.oauth;
  if (!o || !req.query.code || req.query.state !== o.state) {
    return res.status(400).send('Sign-in failed. Go back and try again.');
  }
  try {
    const tok = await fetch('https://apis.roblox.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: req.query.code,
        client_id: CLIENT_ID, code_verifier: o.verifier, redirect_uri: REDIRECT
      })
    }).then(r => r.json());
    if (!tok.access_token) throw new Error('No access token: ' + JSON.stringify(tok));
    const info = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + tok.access_token }
    }).then(r => r.json());
    req.session.user = { id: info.sub, name: info.preferred_username || info.name };
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.status(500).send('Sign-in failed. Go back and try again.');
  }
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// ---- mod menu API (add / edit / delete players) ----
const COUNTS = [2, 3, 6, 4, 5, 8]; // number of sub-stats in each of the 6 categories
const num = (v, lo, hi) => { v = Math.round(Number(v)); if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`Numbers must be between ${lo} and ${hi}.`); return v; };
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const strList = (v, max, n) => (Array.isArray(v) ? v : []).slice(0, n).map(x => str(x, max)).filter(Boolean);
function clean(b) {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(String(b.name || ''))) throw new Error('Name must be a Roblox username: 3 to 20 letters, numbers or underscores.');
  if (!Array.isArray(b.cats) || b.cats.length !== 6) throw new Error('Stats are missing.');
  const cats = b.cats.map((c, i) => {
    const subs = Array.isArray(c && c[1]) ? c[1] : [];
    if (subs.length !== COUNTS[i]) throw new Error('Stats are missing.');
    const v = subs.map(x => num(x, 0, 99));
    return [Math.round(v.reduce((a, x) => a + x, 0) / v.length), v];
  });
  return {
    name: b.name, ovr: num(b.ovr, 1, 99), pos: str(b.pos, 4).toUpperCase(), skill: num(b.skill, 1, 5), value: str(b.value, 10),
    nation: str(b.nation, 4).toUpperCase(), club: str(b.club, 30),
    hair: /^#[0-9a-fA-F]{6}$/.test(b.hair) ? b.hair : '#2b2b2b',
    plus: strList(b.plus, 20, 3),
    trophies: (Array.isArray(b.trophies) ? b.trophies : []).slice(0, 12).map(t => [str(t[0], 30), Math.min(99, Math.max(1, Math.round(Number(t[1])) || 1))]).filter(t => t[0]),
    cats
  };
}
function savePlayers(arr) {
  const f = path.join(__dirname, 'players.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(arr, null, 1));
  fs.renameSync(f + '.tmp', f);
}
app.post('/api/admin/players', needAdmin, async (req, res) => {
  try {
    const p = clean(req.body || {});
    const all = loadPlayers();
    const i = all.findIndex(x => x.name.toLowerCase() === p.name.toLowerCase());
    if (i >= 0) all[i] = p; else all.push(p);
    savePlayers(all);
    avatarCache.delete(p.name.toLowerCase());
    res.json(await withAvatars());
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/admin/players/:name', needAdmin, async (req, res) => {
  const all = loadPlayers();
  const next = all.filter(x => x.name.toLowerCase() !== req.params.name.toLowerCase());
  if (next.length === all.length) return res.status(404).json({ error: 'No such player.' });
  savePlayers(next);
  res.json(await withAvatars());
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`BFL site running on ${BASE_URL} (port ${PORT})`));
