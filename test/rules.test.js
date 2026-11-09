const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyDemo, analyzeReadme, evaluate, composeNote } = require('../server/rules');
const { privateIp } = require('../server/demo-check');

const README = `# Thing\n\nThing is a little tool I made to sort my photos by date and location. ${'It reads the EXIF data and groups pictures into folders by trip. '.repeat(8)}\n\n![screenshot](shot.png)\n\n## How to use\n\nDownload the release and run it.\n`;

const base = (over = {}) => ({
  title: 'Thing', seconds: 5 * 3600, platforms: ['web'], description: 'A tool', codeUrl: 'https://github.com/a/thing',
  demoUrl: 'https://thing.vercel.app', screenshotUrl: 'https://cdn/x.png', githubLogin: 'a',
  repo: { status: 'ok', owner: 'a', readme: README, releases: [], codeBytes: 50000 },
  demoCheck: { status: 200, broken: false }, commits: Array.from({ length: 6 }, (_, i) => ({ committedAt: new Date(Date.now() - i * 864e5).toISOString() })),
  ...over,
});
const ids = (r) => r.findings.map((f) => f.id);

test('classifyDemo', () => {
  const k = (u) => classifyDemo(u).kind;
  assert.equal(k(''), 'none');
  assert.equal(k('https://github.com/a/b'), 'source');
  assert.equal(k('https://github.com/a/b/tree/main'), 'source');
  assert.equal(k('https://github.com/a/b/releases/latest'), 'release');
  assert.equal(k('https://github.com/a/b/releases/download/v1/app.exe'), 'binary');
  assert.equal(k('https://x.onrender.com'), 'render');
  assert.equal(k('https://x.streamlit.app'), 'streamlit');
  assert.equal(k('https://youtu.be/abc'), 'video');
  assert.equal(k('https://drive.google.com/file/d/1'), 'gdrive');
  assert.equal(k('https://colab.research.google.com/drive/1'), 'notebook');
  assert.equal(k('http://localhost:3000'), 'local');
  assert.equal(k('https://abc.ngrok-free.app'), 'ephemeral');
  assert.equal(k('https://leetcode.com/problems/two-sum'), 'leetcode');
  assert.equal(k('https://pypi.org/project/x'), 'store');
  assert.equal(k('https://someone.itch.io/game'), 'store');
  assert.equal(k('example.vercel.app'), 'web');
  assert.equal(k('javascript:alert(1)'), 'invalid');
});

test('analyzeReadme counts words and real images, not badges', () => {
  const r = analyzeReadme('# X\n\n![build](https://img.shields.io/badge/x) Short.');
  assert.equal(r.images, 0);
  assert.equal(r.badges, 1);
  assert.ok(r.words < 5);
  const g = analyzeReadme(README);
  assert.equal(g.images, 1);
  assert.ok(g.words > 80);
  assert.ok(g.instructions);
  assert.ok(analyzeReadme('# Getting Started with Create React App\n\nThis project was bootstrapped').template);
  assert.equal(analyzeReadme('<img src="https://github.com/user-attachments/assets/abc" />').images, 1);
});

test('a complete ship is clean', () => {
  const r = evaluate(base());
  assert.equal(r.verdict, 'clean', JSON.stringify(r.findings));
  assert.equal(r.easy, false);
});

test('no demo link -> easy changes', () => {
  const r = evaluate(base({ demoUrl: '' }));
  assert.equal(r.verdict, 'changes');
  assert.ok(r.easy);
  assert.ok(ids(r).includes('demo-none'));
  const note = composeNote(r, { title: 'Thing' }, { handle: '@me' });
  assert.match(note, /no demo link/i);
  assert.match(note, /DM @me$/);
});

test('demo that is the repo, render, video, broken', () => {
  assert.ok(ids(evaluate(base({ demoUrl: 'https://github.com/a/thing' }))).includes('demo-source'));
  assert.ok(ids(evaluate(base({ demoUrl: 'https://thing.onrender.com' }))).includes('demo-render'));
  assert.ok(ids(evaluate(base({ demoUrl: 'https://youtu.be/x' }))).includes('demo-video'));
  const b = evaluate(base({ demoCheck: { status: 404, broken: true, confident: true } }));
  assert.ok(ids(b).includes('demo-broken'));
  assert.ok(b.easy);
  const slow = evaluate(base({ demoCheck: { status: 200, broken: false, ms: 42000 } }));
  assert.ok(ids(slow).includes('demo-slow'));
});

test('release with only source code', () => {
  const r = evaluate(base({ platforms: ['windows'], demoUrl: 'https://github.com/a/thing/releases/tag/v1', repo: { ...base().repo, releases: [{ tag: 'v1', assets: [] }] } }));
  assert.ok(ids(r).includes('release-source-only'));
  assert.ok(ids(r).includes('no-build'));
  const ok = evaluate(base({ platforms: ['windows'], demoUrl: 'https://github.com/a/thing/releases/tag/v1', repo: { ...base().repo, releases: [{ tag: 'v1', assets: ['thing.exe'] }] } }));
  assert.equal(ok.verdict, 'clean', JSON.stringify(ok.findings));
});

test('README rules', () => {
  const short = evaluate(base({ repo: { ...base().repo, readme: '# Thing\n\nIt does stuff.\n\n![s](a.png)' } }));
  assert.ok(ids(short).includes('readme-short'));
  const noImg = evaluate(base({ repo: { ...base().repo, readme: README.replace('![screenshot](shot.png)', '') } }));
  assert.ok(ids(noImg).includes('readme-no-images'));
  assert.ok(!ids(evaluate(base({ repo: { ...base().repo, readme: README.replace('![screenshot](shot.png)', '') } }), { requireReadmeImage: false })).includes('readme-no-images'));
  assert.ok(ids(evaluate(base({ repo: { ...base().repo, readme: null } }))).includes('readme-missing'));
  // a README that is only a title is too short, not a framework template
  const title = evaluate(base({ repo: { ...base().repo, readme: '# 2DFormule' } }));
  assert.ok(ids(title).includes('readme-short'));
  assert.ok(!ids(title).includes('readme-template'));
  assert.equal(title.findings.find((f) => f.id === 'readme-short').confidence, 'high');
});

test('school assignment -> reject', () => {
  const r = evaluate(base({ description: 'My final project for my computer science class' }));
  assert.equal(r.verdict, 'reject');
  assert.match(composeNote(r, { title: 'Thing' }), /school assignment/);
  assert.equal(evaluate(base({ description: 'An app to plan my school timetable' })).verdict, 'clean');
});

test('fraud signals beat changes', () => {
  const r = evaluate(base({ demoUrl: '', flags: [{ kind: 'x', severity: 'danger', title: 'Scripted heartbeats' }] }));
  assert.equal(r.verdict, 'fraud');
  assert.ok(r.easy);
  assert.equal(evaluate(base({ flags: [{ kind: 'x', severity: 'danger', dismissedAt: '2026-01-01' }] })).verdict, 'clean');
  assert.equal(evaluate(base({ unifiedUrlMatches: [{}] })).verdict, 'fraud');
  assert.equal(evaluate(base({ unifiedUrlMatches: [{}], isUpdate: true })).verdict, 'clean');
  assert.equal(evaluate(base({ seconds: 10 * 3600, repo: { ...base().repo, codeBytes: 900 } })).verdict, 'fraud');
  const now = Date.now();
  assert.ok(ids(evaluate(base({ seconds: 12 * 3600, commits: [{ committedAt: new Date(now).toISOString() }, { committedAt: new Date(now - 6e5).toISOString() }] }))).includes('commit-burst'));
  // a changes ship with a weak fraud hint is not "easy"
  assert.equal(evaluate(base({ demoUrl: '', sessions: [{ seconds: 9 * 3600 }] })).easy, false);
});

test('private repo', () => {
  assert.ok(ids(evaluate(base({ repo: { ...base().repo, private: true } }))).includes('repo-private'));
});

test('single commit for real hours', () => {
  const r = evaluate(base({ commits: [{ committedAt: new Date().toISOString() }] }));
  assert.ok(ids(r).includes('single-commit'));
  assert.equal(r.verdict, 'changes');
});

test('privateIp', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1']) assert.ok(privateIp(ip), ip);
  for (const ip of ['8.8.8.8', '76.76.21.21', '2606:4700::1111']) assert.ok(!privateIp(ip), ip);
});
