#!/usr/bin/env node
// Blanche: a review dashboard for Terra that catches the easy reviews.
//   npm start          real Terra (needs your Terra token, set in Settings or TERRA_TOKEN)
//   npm run demo       sample ships, nothing leaves the machine
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Terra, SITE, MAX_VIDEO, videoUrlFrom } = require('./terra');
const { GitHub } = require('./github');
const { checkDemo } = require('./demo-check');
const { Analyzer, shipProblems, decisionSteps, approveProblems } = require('./analyze');
const { DEFAULTS } = require('./rules');
const G = require('./guidelines');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.BLANCHE_DATA || path.join(ROOT, '.blanche');
const CONFIG = path.join(DATA, 'config.json');
const LOG = path.join(DATA, 'writes.jsonl');
const IGNORED = path.join(DATA, 'ignored.json');
const VIDEOS = path.join(DATA, 'videos');
const DEMO = process.argv.includes('--demo') || process.env.BLANCHE_DEMO === '1';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8790);
const VERLOCK = process.env.VERLOCK_URL || 'https://verlock.hackclub.dev';

// ---------- config ----------

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}
function saveConfig(c) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2), { mode: 0o600 });
}
let config = loadConfig();
const terraToken = () => process.env.TERRA_TOKEN || config.terraToken || '';
// Terra tokens are JWTs that last 7 days: read the expiry (no verification needed, it's only a reminder).
function tokenExpiry(t) {
  try {
    const exp = JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')).exp;
    return Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : null;
  } catch { return null; }
}
const githubToken = () => process.env.GITHUB_TOKEN || config.githubToken || '';
const settings = () => ({ ...DEFAULTS, ...(config.rules || {}), handle: config.handle || '' });

// Findings the reviewer chose to ignore, per ship: { sid: { findingId: { reason, at } } }
let ignored = (() => { try { return JSON.parse(fs.readFileSync(IGNORED, 'utf8')); } catch { return {}; } })();
const ignores = {
  get: (sid) => ignored[sid] || {},
  set(sid, id, value) {
    const cur = { ...(ignored[sid] || {}) };
    if (value) cur[id] = value; else delete cur[id];
    if (Object.keys(cur).length) ignored[sid] = cur; else delete ignored[sid];
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(IGNORED, JSON.stringify(ignored, null, 2), { mode: 0o600 });
  },
};

// Review videos waiting for an approval: id -> { sid, file, size, type, at }. Kept on disk, dropped after use or an hour.
const staged = new Map();
const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
function dropVideo(id) {
  const v = staged.get(id);
  staged.delete(id);
  if (v) fs.rm(v.file, { force: true }, () => {});
}
setInterval(() => { for (const [id, v] of staged) if (Date.now() - v.at > 3600e3) dropVideo(id); }, 600e3).unref();

async function stageVideo(req, sid) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!VIDEO_TYPES[type]) throw Object.assign(new Error('The video has to be MP4, WebM or MOV.'), { status: 415 });
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_VIDEO) throw Object.assign(new Error('The video has to be under 100 MB.'), { status: 413 });
  fs.mkdirSync(VIDEOS, { recursive: true });
  const id = crypto.randomUUID();
  const file = path.join(VIDEOS, `${id}.${VIDEO_TYPES[type]}`);
  const out = fs.createWriteStream(file, { mode: 0o600 });
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_VIDEO) throw Object.assign(new Error('The video has to be under 100 MB.'), { status: 413 });
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy();
    fs.rm(file, { force: true }, () => {});
    throw e;
  }
  if (!size) { fs.rm(file, { force: true }, () => {}); throw Object.assign(new Error('The video is empty.'), { status: 400 }); }
  staged.set(id, { sid, file, size, type, at: Date.now() });
  return { id, size, type };
}

// ---------- services ----------

let terra, github, analyzer;
function wire() {
  if (DEMO) {
    const { FakeTerra, fakeGitHub, fakeCheckDemo } = require('./fixtures');
    terra = terra || new FakeTerra();
    github = fakeGitHub;
    analyzer = new Analyzer({ terra, github, checkDemo: fakeCheckDemo, settings, ignores });
  } else {
    terra = new Terra({ token: terraToken(), logFile: LOG });
    github = new GitHub(githubToken());
    analyzer = new Analyzer({ terra, github, checkDemo: (u) => checkDemo(u), settings, ignores });
  }
}
wire();

// ---------- http helpers ----------

const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', HOST, ...(process.env.BLANCHE_ALLOWED_HOSTS || '').split(',').filter(Boolean)]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 1e6) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  return s ? JSON.parse(s) : {};
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.resolve(ROOT, 'public', rel);
  if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) return send(res, 404, { error: 'not found' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self'; img-src * data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  });
}

const diffs = new Map(); // "codeUrl sha" -> short diff (commits don't change)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------- routes ----------

async function api(req, res, url) {
  const p = url.pathname;
  const m = (re) => p.match(re);
  let x;

  if (p === '/api/status' && req.method === 'GET') {
    let me = null;
    let error = null;
    if (DEMO || terraToken()) {
      try { me = await terra.me(); } catch (e) { error = e.message; }
    }
    return send(res, 200, {
      demo: DEMO, terraToken: !!terraToken(), terraTokenExpires: DEMO ? null : tokenExpiry(terraToken()),
      terraTokenFrom: process.env.TERRA_TOKEN ? 'env' : config.terraToken ? 'settings' : null, githubToken: !!githubToken(), me: me && (me.user || me), error,
      site: SITE, verlock: VERLOCK, guidelines: G.HOME, settings: settings(), dryRun: config.dryRun !== false,
    });
  }

  if (p === '/api/queue' && req.method === 'GET') {
    const queue = url.searchParams.get('queue') || 'review';
    const filter = url.searchParams.get('filter') || 'waiting';
    const items = await terra.queue(queue, filter);
    return send(res, 200, {
      items: items.map((i) => {
        const a = analyzer.view(i.id);
        return { ...i, analysis: a ? { verdict: a.verdict, easy: a.easy, top: a.top, count: a.findings.length } : null };
      }),
    });
  }

  if ((x = m(/^\/api\/analyze\/([^/]+)$/)) && req.method === 'GET') {
    if (!UUID.test(x[1])) return send(res, 400, { error: 'bad id' });
    const a = await analyzer.analyze(x[1], { fresh: url.searchParams.get('fresh') === '1' });
    return send(res, 200, { ...a, links: links(a) });
  }

  // Short diff for one of the ship's commits. The repo comes from the ship itself and the sha must be
  // one of its commits, so this can't be used to fetch anything else from GitHub.
  if ((x = m(/^\/api\/diff\/([^/]+)\/([^/]+)$/)) && req.method === 'GET') {
    const [, sid, sha] = x;
    if (!UUID.test(sid)) return send(res, 400, { error: 'bad id' });
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return send(res, 400, { error: 'bad commit' });
    const a = await analyzer.analyze(sid);
    if (!(a.commits || []).some((c) => c.sha === sha)) return send(res, 404, { error: "That commit isn't on this ship." });
    if (!a.ship.codeUrl) return send(res, 404, { error: 'This ship has no repo.' });
    const key = `${a.ship.codeUrl} ${sha}`;
    let d = diffs.get(key);
    if (!d) {
      d = await github.commit(a.ship.codeUrl, sha);
      if (d.status === 'ok') {
        diffs.set(key, d);
        if (diffs.size > 500) diffs.delete(diffs.keys().next().value);
      }
    }
    if (d.status !== 'ok') return send(res, d.status === 'missing' ? 404 : 502, { error: d.error });
    return send(res, 200, d);
  }

  // Ignore (or un-ignore) one of Blanche's findings on a ship. Only changes Blanche's verdict; nothing goes to Terra.
  if ((x = m(/^\/api\/ignore\/([^/]+)$/)) && req.method === 'POST') {
    if (!UUID.test(x[1])) return send(res, 400, { error: 'bad id' });
    const b = await readBody(req);
    const a = await analyzer.analyze(x[1]);
    if (!a.findings.some((f) => f.id === b.findingId)) return send(res, 404, { error: "That finding isn't on this ship." });
    ignores.set(x[1], b.findingId, b.ignore === false ? null : { reason: String(b.reason || '').trim().slice(0, 500), at: new Date().toISOString() });
    return send(res, 200, { ...analyzer.view(x[1]), links: links(a) });
  }

  // Stage a review video for an approval (raw body). Nothing is sent to Terra until the approval goes out.
  if ((x = m(/^\/api\/video\/([^/]+)$/)) && req.method === 'POST') {
    if (!UUID.test(x[1])) return send(res, 400, { error: 'bad id' });
    return send(res, 200, await stageVideo(req, x[1]));
  }

  if ((x = m(/^\/api\/decide\/([^/]+)$/)) && req.method === 'POST') {
    if (!UUID.test(x[1])) return send(res, 400, { error: 'bad id' });
    const b = await readBody(req);
    const verdict = b.verdict;
    if (!['changes', 'reject', 'fraud', 'approve'].includes(verdict)) return send(res, 400, { error: 'verdict must be changes, reject, fraud or approve' });
    const note = String(b.note || '').trim();
    if (verdict !== 'approve' && note.length < 20) return send(res, 400, { error: verdict === 'fraud' ? 'Write a move note for fraud (20+ characters).' : 'Write a note to the player (20+ characters).' });
    if (verdict === 'approve') return approve(res, x[1], b, note);
    // always decide against the ship as it is now, not as it was when it was scanned
    const d = await terra.shipment(x[1]);
    const problems = shipProblems(d, verdict);
    if (problems.length) return send(res, 409, { error: `Can't decide this ship: ${problems.join('; ')}.`, problems });
    if (b.evidenceVersion != null && b.evidenceVersion !== d.shipment.evidenceVersion) {
      return send(res, 409, { error: 'The ship changed since Blanche scanned it. Rescan and check again.' });
    }
    const steps = decisionSteps(d, verdict, { note, internalNote: b.internalNote });
    const dryRun = b.dryRun !== false;
    if (dryRun) return send(res, 200, { dryRun: true, steps });
    const done = [];
    for (const s of steps) {
      try {
        done.push({ ...s, answer: await terra.write(s.method, s.path, s.body) });
      } catch (e) {
        // the claim went through but the decision didn't: give the claim back
        if (done.length && /\/claim$/.test(done[0].path)) {
          await terra.write('DELETE', done[0].path, undefined, { queue: 'review' }).catch(() => {});
        }
        return send(res, 502, { error: `${s.method} ${s.path} failed: ${e.message}. Nothing after it was sent.`, done });
      }
    }
    analyzer.cache.delete(x[1]);
    return send(res, 200, { dryRun: false, done });
  }

  if ((x = m(/^\/api\/release\/([^/]+)$/)) && req.method === 'POST') {
    if (!UUID.test(x[1])) return send(res, 400, { error: 'bad id' });
    await terra.write('DELETE', `/review/shipment/${x[1]}/claim`, undefined, { queue: 'review' });
    return send(res, 200, { ok: true });
  }

  if (p === '/api/settings' && req.method === 'POST') {
    const b = await readBody(req);
    if (typeof b.terraToken === 'string') config.terraToken = b.terraToken.trim().replace(/^"|"$/g, '') || undefined;
    if (typeof b.githubToken === 'string') config.githubToken = b.githubToken.trim() || undefined;
    if (typeof b.handle === 'string') config.handle = b.handle.trim();
    if (typeof b.dryRun === 'boolean') config.dryRun = b.dryRun;
    if (b.rules && typeof b.rules === 'object') {
      config.rules = {};
      for (const [k, v] of Object.entries(b.rules)) {
        if (k in DEFAULTS && k !== 'handle' && typeof v === typeof DEFAULTS[k]) config.rules[k] = v;
      }
    }
    saveConfig(config);
    wire();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/log' && req.method === 'GET') {
    let lines = [];
    try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-50).map((l) => JSON.parse(l)); } catch {}
    return send(res, 200, { entries: lines.reverse() });
  }

  return send(res, 404, { error: 'not found' });
}

// Approve: claim, acknowledge Terra's danger flags, upload the test video, approve. Checked against the ship
// as it is now and against Blanche's findings (all blocking ones must be ignored first).
async function approve(res, sid, b, note) {
  const form = { ...(b.form || {}) };
  const video = form.videoId ? staged.get(form.videoId) : null;
  if (form.videoId && (!video || video.sid !== sid)) return send(res, 400, { error: 'That video upload expired. Attach it again.' });
  form.video = video ? { size: video.size, type: video.type } : null;
  await analyzer.analyze(sid);
  const d = await terra.shipment(sid);
  const problems = [...shipProblems(d, 'approve'), ...approveProblems(d, form, { blocking: analyzer.blockingFindings(sid) })];
  if (problems.length) return send(res, 409, { error: `Can't approve this ship: ${problems.join('; ')}.`, problems });
  if (b.evidenceVersion != null && b.evidenceVersion !== d.shipment.evidenceVersion) {
    return send(res, 409, { error: 'The ship changed since Blanche scanned it. Rescan and check again.' });
  }
  const steps = decisionSteps(d, 'approve', { note, form });
  if (b.dryRun !== false) return send(res, 200, { dryRun: true, steps });
  const done = [];
  for (const s of steps) {
    try {
      if (s.method === 'UPLOAD') {
        const answer = await terra.upload(s.path, { file: await fs.openAsBlob(video.file, { type: video.type }), type: video.type, size: video.size });
        const url = videoUrlFrom(answer);
        if (!url) throw new Error("Terra took the video but its answer had no video URL, so Blanche didn't approve. Approve it in Terra");
        steps[steps.length - 1].body.videoUrl = url;
        done.push({ ...s, answer });
      } else {
        done.push({ ...s, answer: await terra.write(s.method, s.path, s.body) });
      }
    } catch (e) {
      if (done.length && /\/claim$/.test(done[0].path)) {
        await terra.write('DELETE', done[0].path, undefined, { queue: 'review' }).catch(() => {});
      }
      return send(res, 502, { error: `${s.method} ${s.path} failed: ${e.message}. Nothing after it was sent.`, done });
    }
  }
  dropVideo(form.videoId);
  analyzer.cache.delete(sid);
  return send(res, 200, { dryRun: false, done });
}

function links(a) {
  const s = a.ship;
  return {
    terra: `${SITE}/admin/review/${a.sid}`,
    repo: s.codeUrl || null,
    demo: a.demo && a.demo.url ? a.demo.url : null,
    // verlock clones the repo into a disposable desktop and runs it; ?r= starts the session straight away
    verlock: s.codeUrl ? `${VERLOCK}/?r=${encodeURIComponent(s.codeUrl)}` : null,
  };
}

// ---------- password (for hosting) ----------
// With BLANCHE_PASSWORD set, every request needs HTTP Basic auth (any username, that password).
// Failed attempts are throttled across the whole server so the password can't be brute forced.
const PASSWORD = process.env.BLANCHE_PASSWORD || '';
const failures = [];
function authorized(req) {
  if (!PASSWORD) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const given = crypto.createHash('sha256').update(decoded.slice(decoded.indexOf(':') + 1)).digest();
  const want = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(given, want);
}
function throttled() {
  const now = Date.now();
  while (failures.length && now - failures[0] > 60e3) failures.shift();
  return failures.length >= 20;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true });
  if (PASSWORD) {
    if (throttled()) return send(res, 429, { error: 'Too many wrong passwords. Try again in a minute.' });
    if (!authorized(req)) {
      if (req.headers.authorization) failures.push(Date.now());
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Blanche", charset="UTF-8"', 'Content-Type': 'text/plain' });
      return res.end('Blanche needs its password.');
    }
  } else {
    // unauthenticated, so it must only answer to localhost names (DNS rebinding)
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!allowedHosts.has(host)) return send(res, 421, { error: 'unknown host' });
  }
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
  // anything that changes state needs a header a cross-site form or image can't send
  if (req.method !== 'GET' && req.headers['x-blanche'] !== '1') return send(res, 403, { error: 'missing X-Blanche header' });
  try {
    await api(req, res, url);
  } catch (e) {
    send(res, e.status && e.status < 600 ? e.status : 500, { error: e.message || 'failed' });
  }
});

// BLANCHE_AUTH=proxy: the host's own login (e.g. Orchard's ingress protection) guards Blanche, so it
// skips its password. It still only answers to the names in BLANCHE_ALLOWED_HOSTS, so the app can't be
// reached past the login by its bare IP or another name.
const PROXY_AUTH = process.env.BLANCHE_AUTH === 'proxy';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
if (require.main === module) {
  if (PROXY_AUTH && !(process.env.BLANCHE_ALLOWED_HOSTS || '').trim()) {
    console.error('BLANCHE_AUTH=proxy needs BLANCHE_ALLOWED_HOSTS: the public host name(s) the login proxy serves Blanche on.');
    process.exit(1);
  }
  if (!LOOPBACK.includes(HOST) && !PASSWORD && !PROXY_AUTH && !DEMO) {
    console.error(`Refusing to listen on ${HOST} without a login: set BLANCHE_PASSWORD, or BLANCHE_AUTH=proxy if a login proxy sits in front. Otherwise anyone who can reach it could act with your Terra token.`);
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log(`Blanche ${DEMO ? '(demo mode, sample ships) ' : ''}on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Login: ${PASSWORD ? 'Blanche password' : PROXY_AUTH ? `proxy (answers to ${process.env.BLANCHE_ALLOWED_HOSTS})` : 'none (local only)'}`);
    if (!DEMO && !terraToken()) console.log('No Terra token yet: open the dashboard and add it in Settings.');
  });
}

module.exports = { server };
