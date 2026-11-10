// End-to-end against the demo-mode server: every sample ship lands in the bucket it was built for,
// and decisions go through the request guards.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.BLANCHE_DEMO = '1';
process.env.BLANCHE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'blanche-'));
const { server } = require('../server/index');
const { uuid } = require('../server/fixtures');

let base;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());

const get = (p) => fetch(base + p).then((r) => r.json());
const post = (p, body, headers = { 'X-Blanche': '1' }) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('every sample ship gets the expected verdict', async () => {
  const expected = {
    1: ['changes', 'demo-none'], 2: ['changes', 'demo-source'], 3: ['changes', 'demo-render'], 4: ['changes', 'demo-video'],
    5: ['changes', 'demo-broken'], 6: ['changes', 'readme-no-images'], 7: ['changes', 'readme-template'], 8: ['reject', 'school'],
    9: ['fraud', 'danger-flags'], 10: ['fraud', 'double-dip'], 11: ['changes', 'release-source-only'], 12: ['changes', 'demo-streamlit'],
    13: ['clean', null],
  };
  for (const [n, [verdict, id]] of Object.entries(expected)) {
    const a = await get(`/api/analyze/${uuid(Number(n))}`);
    assert.equal(a.verdict, verdict, `ship ${n} ${a.ship.title}: ${JSON.stringify(a.findings.map((f) => f.id))}`);
    if (id) assert.ok(a.findings.some((f) => f.id === id), `ship ${n} missing ${id}`);
    assert.match(a.links.verlock, /^https:\/\/verlock\.hackclub\.dev\/\?r=https%3A%2F%2Fgithub\.com%2F/);
  }
});

test('queue carries scan results', async () => {
  const q = await get('/api/queue');
  assert.equal(q.items.length, 13);
  assert.ok(q.items.filter((i) => i.analysis && i.analysis.easy).length >= 8);
});

test('writes need the X-Blanche header and a real note', async () => {
  const sid = uuid(1);
  assert.equal((await post(`/api/decide/${sid}`, { verdict: 'changes', note: 'x'.repeat(40) }, {})).status, 403);
  assert.equal((await post(`/api/decide/${sid}`, { verdict: 'changes', note: 'short' })).status, 400);
  assert.equal((await post(`/api/decide/${sid}`, { verdict: 'accept', note: 'x'.repeat(40) })).status, 400);
  // fetch drops a custom Host header, so use http directly (DNS rebinding check)
  const status = await new Promise((resolve, reject) => {
    const u = new URL(base);
    require('node:http').get({ host: u.hostname, port: u.port, path: '/api/status', headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.equal(status, 421);
});

test('dry run shows claim then decision; live run removes it from the queue', async () => {
  const sid = uuid(1);
  const dry = await (await post(`/api/decide/${sid}`, { verdict: 'changes', note: 'Please add a demo link people can open.' })).json();
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.steps.map((s) => `${s.method} ${s.path}`), [`POST /review/shipment/${sid}/claim`, `POST /review/shipment/${sid}/changes`]);
  assert.equal(dry.steps[1].body.evidenceVersion, 1);
  const live = await (await post(`/api/decide/${sid}`, { verdict: 'changes', note: 'Please add a demo link people can open.', dryRun: false })).json();
  assert.equal(live.dryRun, false);
  assert.ok(!(await get('/api/queue')).items.some((i) => i.id === sid));
  const fraud = await (await post(`/api/decide/${uuid(9)}`, { verdict: 'fraud', note: 'Danger flag: scripted heartbeats.' })).json();
  assert.deepEqual(fraud.steps[1].body, { hold: 'fraud', note: 'Danger flag: scripted heartbeats.' });
});

test('stale evidence is refused', async () => {
  const r = await post(`/api/decide/${uuid(2)}`, { verdict: 'changes', note: 'Please link a build, not the repo.', evidenceVersion: 0 });
  assert.equal(r.status, 409);
});

test('journals come oldest first, commits newest first, each tagged to its journal', async () => {
  const a = await get(`/api/analyze/${uuid(13)}`);
  assert.equal(a.journals.length, 3);
  assert.deepEqual(a.journals.map((j) => j.title), ['Day 1: getting started', 'Day 2: the hard part', 'Day 3: polish and ship']);
  assert.equal(a.commits.length, 21);
  const t = a.commits.map((c) => Date.parse(c.committedAt));
  assert.deepEqual(t, t.slice().sort((x, y) => y - x));
  const ids = new Set(a.journals.map((j) => j.id));
  assert.ok(a.commits.filter((c) => c.journalId).every((c) => ids.has(c.journalId)));
  assert.equal(a.commits.filter((c) => !c.journalId).length, 2);
  for (const j of a.journals) assert.ok(a.commits.some((c) => c.journalId === j.id), `${j.title} has no commits`);
});

test('short diff for a ship commit; refuses commits that are not on the ship', async () => {
  const sid = uuid(13);
  const a = await get(`/api/analyze/${sid}`);
  const r = await fetch(`${base}/api/diff/${sid}/${a.commits[0].sha}`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.files[0].filename, 'src/main.js'); // biggest change first
  assert.equal(d.files[0].patch.split('\n').length, 24);
  assert.ok(d.files[0].cut > 0);
  assert.equal(d.files.find((f) => f.filename.endsWith('.png')).patch, null);
  assert.equal((await fetch(`${base}/api/diff/${sid}/${'b'.repeat(40)}`)).status, 404);
  assert.equal((await fetch(`${base}/api/diff/${sid}/not-a-sha`)).status, 400);
});

const json = async (r) => ({ status: r.status, body: await r.json() });
const goodForm = (extra = {}) => ({
  builtWhat: 'A canvas orbit simulator with adjustable gravity and saved scenes.',
  projectReview: 'Opened the hosted demo, created two bodies, changed gravity and saved a scene; everything worked and the README explains setup.',
  multiplier: 1.1, deflationSeconds: 0, flagReasons: {}, ...extra,
});
const stage = (sid, bytes = 2048, type = 'video/mp4') =>
  fetch(`${base}/api/video/${sid}`, { method: 'POST', headers: { 'Content-Type': type, 'X-Blanche': '1' }, body: Buffer.alloc(bytes, 1) }).then(json);

test('ignoring a finding takes it out of the verdict, and undo puts it back', async () => {
  const sid = uuid(3); // Render demo: changes
  const a = await get(`/api/analyze/${sid}`);
  assert.equal(a.verdict, 'changes');
  const blocking = a.findings.filter((f) => ['changes', 'reject', 'fraud'].includes(f.verdict));
  let v;
  for (const f of blocking) v = (await json(await post(`/api/ignore/${sid}`, { findingId: f.id, reason: 'host is fine now' }))).body;
  assert.equal(v.verdict, 'clean');
  assert.equal(v.before.verdict, 'changes');
  assert.equal(v.ignoredCount, blocking.length);
  assert.ok(v.findings.find((f) => f.id === blocking[0].id).ignored);
  assert.equal(v.problems.approve.length, 0);
  const q = await get('/api/queue');
  assert.equal(q.items.find((i) => i.id === sid).analysis.verdict, 'clean');
  v = (await json(await post(`/api/ignore/${sid}`, { findingId: blocking[0].id, ignore: false }))).body;
  assert.equal(v.verdict, 'changes');
  assert.equal((await post(`/api/ignore/${sid}`, { findingId: 'nope' })).status, 404);
});

test('approve is refused while Blanche still flags the ship, or without a video', async () => {
  const sid = uuid(1); // no demo link: changes
  const r = await json(await post(`/api/decide/${sid}`, { verdict: 'approve', note: '', form: goodForm() }));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /ignore those findings first/);
  assert.match(r.body.error, /test video/);
});

test('approve dry run: ignore, video, then claim / acknowledge flag / upload / approve', async () => {
  const sid = uuid(9); // fraud: Terra danger flag + commit burst
  const a = await get(`/api/analyze/${sid}`);
  assert.equal(a.approve.dangerFlags[0].kind, 'hackatime_pattern');
  assert.equal(a.approve.videoOptional, false);
  for (const f of a.findings.filter((x) => ['changes', 'reject', 'fraud'].includes(x.verdict))) {
    await post(`/api/ignore/${sid}`, { findingId: f.id, reason: 'checked by hand' });
  }
  const noAck = await json(await post(`/api/decide/${sid}`, { verdict: 'approve', note: '', form: goodForm({ videoId: (await stage(sid)).body.id }) }));
  assert.equal(noAck.status, 409);
  assert.match(noAck.body.error, /acknowledge the "Heartbeats look scripted" flag/);

  assert.equal((await stage(sid, 10, 'text/plain')).status, 415);
  const vid = (await stage(sid)).body;
  const form = goodForm({ videoId: vid.id, flagReasons: { hackatime_pattern: 'Looked at sessions, normal typing' }, multiplier: 1.6 });
  assert.match((await json(await post(`/api/decide/${sid}`, { verdict: 'approve', note: '', form }))).body.error, /multiplier/);
  form.multiplier = 1.1;
  const dry = (await json(await post(`/api/decide/${sid}`, { verdict: 'approve', note: 'Nice!', form }))).body;
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.steps.map((s) => `${s.method} ${s.path}`), [
    `POST /review/shipment/${sid}/claim`, `POST /review/shipment/${sid}/flags/hackatime_pattern/dismiss`,
    `UPLOAD /review/shipment/${sid}/video`, `POST /review/shipment/${sid}/approve`]);
  const body = dry.steps[3].body;
  assert.equal(body.payoutMultiplier, 1.1);
  assert.equal(body.evidenceVersion, 1);
  assert.equal(body.updateJustification, '');

  const live = (await json(await post(`/api/decide/${sid}`, { verdict: 'approve', note: 'Nice!', form, dryRun: false }))).body;
  assert.equal(live.dryRun, false);
  assert.equal(live.done[3].body.videoUrl, 'https://terra.hackclub-assets.com/00000000-demo.mp4');
  assert.ok(!(await get('/api/queue')).items.some((i) => i.id === sid));
});

test('double-dip ship needs an update justification to approve', async () => {
  const sid = uuid(10);
  const a = await get(`/api/analyze/${sid}`);
  assert.equal(a.approve.needsUpdateJustification, true);
  for (const f of a.findings.filter((x) => ['changes', 'reject', 'fraud'].includes(x.verdict))) await post(`/api/ignore/${sid}`, { findingId: f.id });
  const form = goodForm({ videoId: (await stage(sid)).body.id });
  assert.match((await json(await post(`/api/decide/${sid}`, { verdict: 'approve', note: '', form }))).body.error, /update justification/);
  form.updateJustification = 'This is a new version with a rewritten physics engine since the SoM ship.';
  assert.equal((await post(`/api/decide/${sid}`, { verdict: 'approve', note: '', form })).status, 200);
});

test('re-ship: last request, topics checked against today, and work since', async () => {
  const a = await get(`/api/analyze/${uuid(6)}`);
  const r = a.reship;
  assert.ok(r, 'ship 6 had a changes request');
  assert.match(r.last.note, /no screenshots/);
  assert.equal(r.last.reviewer, 'ada_reviews');
  const t = Object.fromEntries(r.topics.map((x) => [x.key, x.status]));
  assert.equal(t.screenshot, 'flagged'); // README still has no images
  assert.equal(t.readme, 'flagged');
  assert.equal(t.howto, 'ok');
  assert.ok(r.newCommits > 0 && r.newCommits < a.commits.length);
  assert.equal(r.earlier.length, 1);
  assert.equal((await get(`/api/analyze/${uuid(13)}`)).reship, null);
});

test('status reads the Terra token expiry', async () => {
  const s = await get('/api/status');
  assert.equal(s.terraTokenExpires, null); // demo mode
});
