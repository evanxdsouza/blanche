// Hosted mode: with BLANCHE_PASSWORD set, everything except /healthz needs the password,
// and without one the server refuses to listen on a public address.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const entry = path.join(__dirname, '..', 'server', 'index.js');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'blanche-auth-'));
const port = 20000 + Math.floor(Math.random() * 20000);
let child;

test.before(async () => {
  child = spawn(process.execPath, [entry], {
    env: { ...process.env, HOST: '0.0.0.0', PORT: String(port), BLANCHE_PASSWORD: 'correct horse', BLANCHE_DATA: data, TERRA_TOKEN: '' },
    stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => /on http/.test(d) && resolve());
    child.on('exit', (c) => reject(new Error(`exited ${c}`)));
  });
});
test.after(() => child.kill());

const url = (p) => `http://127.0.0.1:${port}${p}`;
const basic = (pw) => ({ Authorization: `Basic ${Buffer.from(`x:${pw}`).toString('base64')}` });

test('password protects pages and API, not the health check', async () => {
  assert.equal((await fetch(url('/healthz'))).status, 200);
  const anon = await fetch(url('/'));
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get('www-authenticate'), /Basic/);
  assert.equal((await fetch(url('/api/status'), { headers: basic('wrong') })).status, 401);
  assert.equal((await fetch(url('/'), { headers: basic('correct horse') })).status, 200);
  const st = await fetch(url('/api/status'), { headers: basic('correct horse') });
  assert.equal(st.status, 200);
  // any public host name is fine once the password is required
  assert.equal((await fetch(url('/api/status'), { headers: { ...basic('correct horse') } })).status, 200);
});

test('wrong passwords get throttled', async () => {
  for (let i = 0; i < 20; i++) await fetch(url('/api/status'), { headers: basic(`guess${i}`) });
  assert.equal((await fetch(url('/api/status'), { headers: basic('correct horse') })).status, 429);
});

test('refuses to listen publicly without a password', () => {
  const r = spawnSync(process.execPath, [entry], {
    env: { ...process.env, HOST: '0.0.0.0', PORT: String(port + 1), BLANCHE_PASSWORD: '', BLANCHE_DATA: data }, timeout: 5000, encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to listen/);
});

test('proxy login mode: no password, but only the allowed host name gets through', async () => {
  const p2 = port + 2;
  const c = spawn(process.execPath, [entry], {
    env: { ...process.env, HOST: '0.0.0.0', PORT: String(p2), BLANCHE_PASSWORD: '', BLANCHE_AUTH: 'proxy', BLANCHE_ALLOWED_HOSTS: 'blanche.example.app', BLANCHE_DATA: data, TERRA_TOKEN: '' },
    stdio: 'pipe',
  });
  try {
    await new Promise((resolve, reject) => {
      c.stdout.on('data', (d) => /on http/.test(d) && resolve());
      c.on('exit', (code) => reject(new Error(`exited ${code}`)));
    });
    const status = (host) => new Promise((resolve, reject) => {
      require('node:http').get({ host: '127.0.0.1', port: p2, path: '/api/status', headers: { Host: host } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(await status('blanche.example.app'), 200);
    assert.equal(await status('10.0.0.7'), 421);
    assert.equal(await status('evil.example'), 421);
  } finally {
    c.kill();
  }
});

test('proxy login mode refuses to start without an allowed host', () => {
  const r = spawnSync(process.execPath, [entry], {
    env: { ...process.env, HOST: '0.0.0.0', PORT: String(port + 3), BLANCHE_PASSWORD: '', BLANCHE_AUTH: 'proxy', BLANCHE_ALLOWED_HOSTS: '', BLANCHE_DATA: data }, timeout: 5000, encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BLANCHE_ALLOWED_HOSTS/);
});
