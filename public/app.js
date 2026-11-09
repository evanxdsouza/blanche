'use strict';
// Blanche dashboard. Talks only to the local Blanche server (/api/*), which holds the tokens.

const $ = (s) => document.querySelector(s);
const state = {
  status: null,
  items: [],
  analyses: new Map(), // sid -> full analysis
  bucket: 'easy',
  selected: null,
  search: '',
  scanning: false,
  verdictTab: null,
};

const BUCKETS = [
  ['easy', 'Easy'],
  ['changes', 'Changes'],
  ['reject', 'Reject'],
  ['fraud', 'Fraud'],
  ['clean', 'Looks clean'],
  ['unscanned', 'Unscanned'],
  ['all', 'All'],
];
const VERDICT_LABEL = { changes: 'Changes', reject: 'Reject', fraud: 'Fraud', clean: 'Clean', warn: 'Note' };

// ---------- tiny DOM helper (text only, never innerHTML) ----------
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'href') n.setAttribute('href', safeHref(v));
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
}
function safeHref(u) {
  try {
    const x = new URL(u, location.href);
    return ['http:', 'https:'].includes(x.protocol) ? x.href : '#';
  } catch { return '#'; }
}
const ext = (href, text, cls) => el('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);
const hours = (s) => `${((s || 0) / 3600).toFixed(1)}h`;

// ---------- api ----------
async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Blanche': '1', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status, data });
  return data;
}

let toastTimer;
function toast(msg, error) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), error ? 6000 : 3000);
}

// ---------- status / settings ----------
async function loadStatus() {
  state.status = await api('/api/status');
  const s = state.status;
  $('#guide-link').href = s.guidelines;
  $('#who').textContent = s.me ? `${s.me.username}${s.me.isAdmin ? ' · admin' : ''}${s.demo ? ' · demo' : ''}` : '';
  renderDry();
  const b = $('#banner');
  if (s.demo) {
    b.hidden = false; b.className = 'banner';
    b.textContent = 'Demo mode: these are sample ships and nothing is sent to Terra. Run "npm start" for the real queue.';
  } else if (!s.terraToken) {
    b.hidden = false; b.className = 'banner';
    b.textContent = 'Add your Terra token in Settings to load the queue.';
  } else if (s.error) {
    b.hidden = false; b.className = 'banner error';
    b.textContent = `Terra: ${s.error}`;
  } else b.hidden = true;
}

function renderDry() {
  const d = $('#dry');
  const on = state.status.dryRun;
  d.textContent = on ? 'Dry run: on' : 'Dry run: off (live)';
  d.className = `pill ${on ? 'on' : 'off'}`;
  d.setAttribute('aria-pressed', String(on));
}

$('#dry').addEventListener('click', async () => {
  const next = !state.status.dryRun;
  if (!next && !state.status.demo && !confirm('Turn dry run off? Decisions will be sent to Terra for real.')) return;
  await api('/api/settings', { method: 'POST', body: { dryRun: next } });
  state.status.dryRun = next;
  renderDry();
  renderDetail();
});

$('#settings-btn').addEventListener('click', () => {
  const f = $('#settings-form');
  const s = state.status.settings;
  f.terraToken.value = ''; f.githubToken.value = '';
  f.terraToken.placeholder = state.status.terraToken ? 'saved (leave blank to keep)' : 'not set';
  f.githubToken.placeholder = state.status.githubToken ? 'saved (leave blank to keep)' : 'not set';
  f.handle.value = s.handle || '';
  f.readmeMinWords.value = s.readmeMinWords;
  f.singleCommitHours.value = s.singleCommitHours;
  f.requireReadmeImage.checked = !!s.requireReadmeImage;
  $('#settings').showModal();
});

$('#settings').addEventListener('close', async () => {
  if ($('#settings').returnValue !== 'save') return;
  const f = $('#settings-form');
  const body = {
    handle: f.handle.value,
    rules: {
      readmeMinWords: Number(f.readmeMinWords.value) || 0,
      singleCommitHours: Number(f.singleCommitHours.value) || 0,
      requireReadmeImage: f.requireReadmeImage.checked,
    },
  };
  if (f.terraToken.value.trim()) body.terraToken = f.terraToken.value;
  if (f.githubToken.value.trim()) body.githubToken = f.githubToken.value;
  try {
    await api('/api/settings', { method: 'POST', body });
    state.analyses.clear();
    await loadStatus();
    await loadQueue();
    toast('Settings saved. Rules changed, so rescan to apply them.');
  } catch (e) { toast(e.message, true); }
});

// ---------- queue ----------
async function loadQueue() {
  if (!state.status.demo && !state.status.terraToken) { state.items = []; render(); return; }
  try {
    const { items } = await api(`/api/queue?queue=${encodeURIComponent($('#queue').value)}`);
    state.items = items;
  } catch (e) {
    state.items = [];
    toast(`Couldn't load the queue: ${e.message}`, true);
  }
  render();
}
$('#queue').addEventListener('change', () => { state.analyses.clear(); loadQueue(); });

function summary(item) {
  const a = state.analyses.get(item.id);
  if (a) return { verdict: a.verdict, easy: a.easy, top: a.top };
  return item.analysis;
}

function inBucket(item, bucket) {
  const s = summary(item);
  if (bucket === 'all') return true;
  if (bucket === 'unscanned') return !s;
  if (!s) return false;
  if (bucket === 'easy') return s.easy;
  return s.verdict === bucket;
}

function visible() {
  const q = state.search.toLowerCase();
  return state.items.filter((i) => inBucket(i, state.bucket) &&
    (!q || `${i.title} ${i.username}`.toLowerCase().includes(q)));
}

function render() {
  const nav = $('#buckets');
  nav.replaceChildren(...BUCKETS.map(([k, label]) => el('button', {
    'aria-pressed': String(state.bucket === k),
    onclick: () => { state.bucket = k; render(); },
  }, label, el('span', { class: 'n' }, state.items.filter((i) => inBucket(i, k)).length))));

  const list = $('#list');
  const rows = visible();
  if (!rows.length) {
    const msg = !state.items.length ? 'The queue is empty.'
      : state.bucket === 'unscanned' ? 'Everything is scanned.'
      : state.items.every((i) => !summary(i)) ? 'Press "Scan queue" to sort ships into buckets.'
      : 'Nothing in this bucket.';
    list.replaceChildren(el('li', { class: 'empty-row' }, msg));
    return;
  }
  list.replaceChildren(...rows.map((i) => {
    const s = summary(i);
    const claimed = i.claimedBy && !i.claimedByMe ? ` · claimed by ${i.claimedBy}` : i.hold ? ` · hold: ${i.hold}` : '';
    return el('li', {
      'aria-selected': String(state.selected === i.id), tabindex: 0, 'data-id': i.id,
      onclick: () => select(i.id),
      onkeydown: (e) => { if (e.key === 'Enter') select(i.id); },
    },
    el('span', { class: 't' }, i.title || '(untitled)'),
    el('span', { class: 'v' }, s ? [s.easy ? el('span', { class: 'tag easy' }, 'easy') : null, ' ', el('span', { class: `tag ${s.verdict}` }, VERDICT_LABEL[s.verdict])] : el('span', { class: 'tag none' }, '—')),
    el('span', { class: 'm' }, `${i.username} · ${hours(i.seconds)}${(i.platforms || []).length ? ` · ${i.platforms.join(', ')}` : ''}${claimed}${s && s.top ? ` · ${s.top}` : ''}`));
  }));
}

$('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });

// ---------- scanning ----------
async function analyze(sid, fresh) {
  const a = await api(`/api/analyze/${sid}${fresh ? '?fresh=1' : ''}`);
  state.analyses.set(sid, a);
  return a;
}

async function scan() {
  if (state.scanning) return;
  const todo = state.items.filter((i) => !summary(i));
  if (!todo.length) { toast('Everything is already scanned.'); return; }
  state.scanning = true;
  $('#scan').disabled = true;
  const bar = $('#progress');
  bar.hidden = false;
  let done = 0; let failed = 0;
  const tick = () => {
    bar.firstElementChild.style.width = `${(done / todo.length) * 100}%`;
    bar.lastElementChild.textContent = `${done}/${todo.length}${failed ? ` · ${failed} failed` : ''}`;
  };
  tick();
  // the server paces Terra (100/min), so a few in flight just keeps GitHub and demo checks busy
  const queue = [...todo];
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const i = queue.shift();
      try { await analyze(i.id); } catch (e) { failed++; if (e.status === 401) { queue.length = 0; toast(e.message, true); } }
      done++; tick(); render();
      if (state.selected === i.id) renderDetail();
    }
  }));
  state.scanning = false;
  $('#scan').disabled = false;
  setTimeout(() => (bar.hidden = true), 1500);
  const easy = state.items.filter((i) => summary(i)?.easy).length;
  toast(`Scanned ${done} ships. ${easy} easy ${easy === 1 ? 'review' : 'reviews'}.`);
}
$('#scan').addEventListener('click', scan);

// ---------- detail ----------
async function select(sid) {
  state.selected = sid;
  state.verdictTab = null;
  render();
  if (!state.analyses.has(sid)) {
    $('#detail').replaceChildren(el('p', { class: 'empty' }, 'Checking this ship…'));
    try { await analyze(sid); } catch (e) {
      $('#detail').replaceChildren(el('p', { class: 'empty' }, `Couldn't check this ship: ${e.message}`));
      return;
    }
    render();
  }
  renderDetail();
  $('#detail').scrollTop = 0;
}

function renderDetail() {
  const a = state.analyses.get(state.selected);
  if (!a) return;
  const s = a.ship;
  const tab = state.verdictTab || (['changes', 'reject', 'fraud'].includes(a.verdict) ? a.verdict : 'changes');
  state.verdictTab = tab;

  const head = el('div', { class: 'head' },
    el('h1', {}, s.title || '(untitled)'),
    el('div', { class: 'meta' },
      el('span', { class: `tag ${a.verdict}` }, VERDICT_LABEL[a.verdict]),
      a.easy ? el('span', { class: 'tag easy' }, 'easy') : null,
      el('span', {}, `by ${s.username}`), el('span', {}, hours(s.seconds)),
      s.platforms?.length ? el('span', {}, s.platforms.join(', ')) : null,
      s.isUpdate ? el('span', {}, 'update') : null,
      s.changesRounds ? el('span', {}, `${s.changesRounds} change round(s) before`) : null,
      el('span', {}, `scanned ${new Date(a.analyzedAt).toLocaleTimeString()}`)));

  const L = a.links;
  const links = el('div', { class: 'links' },
    ext(L.terra, 'Open in Terra'),
    L.repo ? ext(L.repo, 'Repo') : null,
    L.demo ? ext(L.demo, 'Demo') : null,
    L.verlock ? ext(L.verlock, 'Open in Verlock', 'verlock') : null,
    el('button', { onclick: () => rescan(a.sid) }, 'Rescan'));

  const findings = el('div', { class: 'card' }, el('h3', {}, `Findings (${a.findings.length})`),
    a.findings.length ? el('ul', { class: 'findings' }, a.findings.map((f) => el('li', { class: f.verdict },
      el('div', { class: 'ft' }, el('span', { class: `tag ${f.verdict}` }, VERDICT_LABEL[f.verdict]), f.title, el('span', { class: 'conf' }, f.confidence)),
      f.detail ? el('div', { class: 'fd' }, f.detail) : null,
      f.guideline ? el('div', { class: 'fg' }, ext(f.guideline.url, f.guideline.title)) : null)))
      : el('p', {}, 'Nothing caught. This one needs a real review: open it in Verlock or test the demo.'));

  const r = a.repo || {};
  const rs = r.readmeStats;
  const demoCheck = a.demo.check;
  const facts = el('div', { class: 'card' }, el('h3', {}, 'Facts'),
    el('dl', { class: 'facts' },
      el('dt', {}, 'Demo'), el('dd', {}, s.demoUrl ? [a.demo.kind, demoCheck ? ` · ${demoCheck.status}${demoCheck.ms != null ? ` in ${(demoCheck.ms / 1000).toFixed(1)}s` : ''}` : ''] : 'none'),
      el('dt', {}, 'Repo'), el('dd', {}, r.status === 'ok' ? `${r.owner}/${r.name}${r.fork ? ' (fork)' : ''}${r.license ? ` · ${r.license}` : ''}${r.codeBytes != null ? ` · ${(r.codeBytes / 1024).toFixed(0)} KB code` : ''}` : r.status || '—'),
      el('dt', {}, 'README'), el('dd', {}, rs === null ? 'missing' : rs ? `${rs.words} words · ${rs.images} image(s)${rs.template ? ' · template' : ''}${rs.instructions ? '' : ' · no how-to'}` : '—'),
      el('dt', {}, 'Releases'), el('dd', {}, r.releases ? (r.releases.length ? r.releases.slice(0, 3).map((x) => `${x.tag}: ${x.assets.length ? x.assets.join(', ') : 'source only'}`).join(' · ') : 'none') : '—'),
      el('dt', {}, 'AI declaration'), el('dd', {}, s.aiDeclaration || 'none'),
      el('dt', {}, 'Description'), el('dd', {}, s.description || '—'),
      el('dt', {}, 'Ship notes'), el('dd', {}, s.shipNotes || '—')),
    s.screenshotUrl ? el('img', { class: 'shot', src: s.screenshotUrl, alt: 'Ship screenshot', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null,
    r.readmeExcerpt ? el('details', { class: 'readme' }, el('summary', {}, 'README'), el('pre', {}, r.readmeExcerpt)) : null);

  $('#detail').replaceChildren(head, links, el('div', { class: 'grid' }, el('div', {}, findings, facts), decideCard(a, tab)), historyCard(a));
}

// ---------- journals & commits ----------
const when = (x) => (x ? new Date(x).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const diffs = new Map(); // "sid sha" -> Promise of the short diff
const openCommits = new Set(); // "sid sha" kept open across re-renders

function historyCard(a) {
  const journals = a.journals || [];
  const commits = a.commits || [];
  const view = state.historyView || 'journal';
  const byId = new Map(journals.map((j, i) => [j.id, { ...j, n: i + 1 }]));
  const untagged = commits.filter((c) => !c.journalId);

  const toggle = el('div', { class: 'tabs seg', role: 'group', 'aria-label': 'History view' },
    [['journal', 'By journal'], ['history', 'Commit history']].map(([k, label]) =>
      el('button', { 'aria-pressed': String(view === k), onclick: () => { state.historyView = k; renderDetail(); } }, label)));

  let body;
  if (!journals.length && !commits.length) {
    body = el('p', { class: 'muted' }, 'Terra has no journals or commits for this ship yet.');
  } else if (view === 'journal') {
    body = el('div', { class: 'journals' },
      journals.map((j, i) => {
        const mine = commits.filter((c) => c.journalId === j.id).reverse(); // oldest first inside a journal
        return el('section', { class: 'journal' },
          el('div', { class: 'jh' },
            el('span', { class: 'jn' }, `#${i + 1}`), el('strong', {}, j.title || '(untitled journal)'),
            el('span', { class: 'muted' }, `${when(j.createdAt)} · ${hours(j.creditedSeconds)} · ${mine.length} commit${mine.length === 1 ? '' : 's'}`)),
          j.body ? el('p', { class: 'jb' }, j.body) : null,
          j.images.length ? el('div', { class: 'jimgs' }, j.images.slice(0, 4).map((u) =>
            el('a', { href: u, target: '_blank', rel: 'noopener noreferrer' },
              el('img', { src: u, alt: `Image from ${j.title || 'journal'}`, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.parentNode.remove() })))) : null,
          mine.length ? el('div', { class: 'commits' }, mine.map((c) => commitRow(a, c, null))) : el('p', { class: 'muted small' }, 'No commits tagged to this journal.'));
      }),
      untagged.length ? el('section', { class: 'journal untagged' },
        el('div', { class: 'jh' }, el('strong', {}, 'Not in any journal'),
          el('span', { class: 'muted' }, `${untagged.length} commit${untagged.length === 1 ? '' : 's'} no journal claims`)),
        el('div', { class: 'commits' }, untagged.slice().reverse().map((c) => commitRow(a, c, null)))) : null);
  } else {
    body = commits.length
      ? el('div', { class: 'commits' }, commits.map((c) => commitRow(a, c, c.journalId ? byId.get(c.journalId) : null, true)))
      : el('p', { class: 'muted' }, 'No commits.');
  }

  const tagged = commits.length - untagged.length;
  return el('div', { class: 'card history' },
    el('div', { class: 'hh' },
      el('h3', {}, `Journals (${journals.length}) & commits (${commits.length})`),
      commits.length ? el('span', { class: 'muted small' }, `${tagged} of ${commits.length} commits tagged to a journal`) : null,
      toggle),
    body);
}

function commitRow(a, c, journal, showJournal) {
  const key = `${a.sid} ${c.sha}`;
  const box = el('div', { class: 'diff' });
  const d = el('details', { class: 'commit', open: openCommits.has(key),
    ontoggle: () => {
      if (d.open) { openCommits.add(key); loadDiff(a.sid, c.sha, box); } else openCommits.delete(key);
    } },
  el('summary', {},
    el('code', { class: 'sha' }, c.sha.slice(0, 7)),
    el('span', { class: 'msg', title: c.message }, (c.message || '(no message)').split('\n')[0]),
    showJournal ? el('span', { class: `jtag${journal ? '' : ' none'}`, title: journal ? journal.title : 'No journal claims this commit' },
      journal ? `#${journal.n} ${journal.title || 'journal'}` : 'no journal') : null,
    el('span', { class: 'stat' }, el('span', { class: 'add' }, `+${c.additions}`), ' ', el('span', { class: 'del' }, `−${c.deletions}`)),
    el('span', { class: 'muted when' }, when(c.committedAt))),
  box);
  return d;
}

function loadDiff(sid, sha, box) {
  if (box.dataset.loaded) return;
  box.dataset.loaded = '1';
  box.replaceChildren(el('p', { class: 'muted small' }, 'Loading diff…'));
  const key = `${sid} ${sha}`;
  if (!diffs.has(key)) diffs.set(key, api(`/api/diff/${sid}/${sha}`));
  diffs.get(key).then((d) => box.replaceChildren(renderDiff(d)), (e) => {
    diffs.delete(key); // let a later open try again (rate limit, GitHub hiccup)
    delete box.dataset.loaded;
    box.replaceChildren(el('p', { class: 'muted small' }, `Couldn't load the diff: ${e.message}`));
  });
}

function renderDiff(d) {
  if (!d.files.length) return el('p', { class: 'muted small' }, 'This commit changes no files.');
  return el('div', {},
    d.files.map((f) => el('div', { class: 'dfile' },
      el('div', { class: 'dfh' },
        el('span', { class: `dst ${f.status}` }, f.status), el('code', {}, f.previous ? `${f.previous} → ${f.filename}` : f.filename),
        el('span', { class: 'stat' }, el('span', { class: 'add' }, `+${f.additions}`), ' ', el('span', { class: 'del' }, `−${f.deletions}`))),
      f.patch == null ? el('p', { class: 'muted small' }, 'Binary or too large to show.')
        : el('pre', { class: 'patch' }, f.patch.split('\n').map((l) =>
          el('span', { class: l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : null }, l || ' ')),
          f.cut ? el('span', { class: 'cut' }, `… ${f.cut} more line${f.cut === 1 ? '' : 's'}`) : null))),
    d.moreFiles ? el('p', { class: 'muted small' }, `… and ${d.moreFiles} more file${d.moreFiles === 1 ? '' : 's'}`) : null,
    d.url ? el('p', { class: 'small' }, ext(d.url, 'Full diff on GitHub')) : null);
}

function decideCard(a, tab) {
  const dry = state.status.dryRun;
  const tabs = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Decision' }, [['changes', 'Request changes'], ['reject', 'Reject'], ['fraud', 'Move to fraud']].map(([k, label]) =>
    el('button', { class: k, 'aria-pressed': String(tab === k), onclick: () => { state.verdictTab = k; renderDetail(); } }, label)));
  const note = el('textarea', { id: 'note', 'aria-label': tab === 'fraud' ? 'Move note' : 'Note to the player' });
  note.value = a.notes[tab] || '';
  const internal = tab === 'fraud' ? null : el('textarea', { id: 'internal', class: 'small', 'aria-label': 'Internal note' });
  const problems = a.problems[tab] || [];
  const out = el('div');
  const btn = el('button', { class: 'primary', onclick: () => decide(a, tab, note.value, internal && internal.value, btn, out) },
    `${dry ? 'Preview' : 'Send'} ${tab === 'changes' ? 'changes' : tab === 'reject' ? 'rejection' : 'to fraud'}`);
  return el('div', { class: 'card decide' }, el('h3', {}, 'Decide'), tabs,
    problems.length ? el('div', { class: 'problems' }, `Terra won't take this right now: ${problems.join('; ')}.`) : null,
    tab === 'reject' ? el('div', { class: 'problems' }, 'A rejection is final: the player can\'t reship this project.') : null,
    el('label', { for: 'note' }, tab === 'fraud' ? 'Move note (for the fraud team)' : 'Note to the player'), note,
    internal ? [el('label', { for: 'internal' }, 'Internal note (staff only, optional)'), internal] : null,
    el('div', { class: 'act' }, btn, el('span', { class: 'hint' }, dry ? 'Dry run: shows the requests without sending them.' : 'Live: claims the ship and sends the decision to Terra.')),
    out);
}

async function decide(a, verdict, note, internalNote, btn, out) {
  const dry = state.status.dryRun;
  if (!dry && verdict === 'reject' && !confirm(`Reject "${a.ship.title}" for good?`)) return;
  btn.disabled = true;
  try {
    const r = await api(`/api/decide/${a.sid}`, { method: 'POST', body: { verdict, note, internalNote, dryRun: dry, evidenceVersion: a.evidenceVersion } });
    if (r.dryRun) {
      out.replaceChildren(el('p', { class: 'hint' }, 'Dry run. These requests would be sent, in order:'),
        el('pre', { class: 'steps' }, r.steps.map((s) => `${s.method} ${s.path}\n${JSON.stringify(s.body, null, 2)}`).join('\n\n')));
    } else {
      toast(`${verdict === 'fraud' ? 'Moved to fraud' : verdict === 'reject' ? 'Rejected' : 'Changes requested'}: ${a.ship.title}`);
      state.items = state.items.filter((i) => i.id !== a.sid);
      state.analyses.delete(a.sid);
      const next = visible()[0];
      if (next) select(next.id); else { state.selected = null; render(); $('#detail').replaceChildren(el('p', { class: 'empty' }, 'Bucket cleared.')); }
    }
  } catch (e) {
    toast(e.message, true);
  } finally { btn.disabled = false; }
}

async function rescan(sid) {
  try { await analyze(sid, true); render(); renderDetail(); toast('Rescanned.'); } catch (e) { toast(e.message, true); }
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
  const rows = visible();
  const idx = rows.findIndex((i) => i.id === state.selected);
  if (e.key === 'j' && rows.length) select(rows[Math.min(rows.length - 1, idx + 1)].id);
  else if (e.key === 'k' && rows.length) select(rows[Math.max(0, idx - 1)].id);
  else if (e.key === 's') scan();
  else if (e.key === 'r' && state.selected) rescan(state.selected);
  else if (e.key === 'v' && state.selected) {
    const l = state.analyses.get(state.selected)?.links?.verlock;
    if (l) window.open(l, '_blank', 'noopener');
  } else return;
  e.preventDefault();
  document.querySelector(`#list li[data-id="${state.selected}"]`)?.scrollIntoView({ block: 'nearest' });
});

(async () => {
  try { await loadStatus(); await loadQueue(); } catch (e) { toast(e.message, true); }
})();
