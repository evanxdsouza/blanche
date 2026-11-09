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
  assert.equal((await post(`/api/decide/${sid}`, { verdict: 'approve', note: 'x'.repeat(40) })).status, 400);
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
