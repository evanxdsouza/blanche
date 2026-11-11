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
  $('#who').replaceChildren(s.me ? `${s.me.username}${s.me.isAdmin ? ' · admin' : ''}${s.demo ? ' · demo' : ''}` : '', ' ', tokenPill(s));
  renderDry();
  const b = $('#banner');
  const left = s.terraTokenExpires ? Date.parse(s.terraTokenExpires) - Date.now() : null;
  if (s.demo) {
    b.hidden = false; b.className = 'banner';
    b.textContent = 'Demo mode: these are sample ships and nothing is sent to Terra. Run "npm start" for the real queue.';
  } else if (!s.terraToken) {
    b.hidden = false; b.className = 'banner';
    b.textContent = 'Add your Terra token in Settings to load the queue.';
  } else if (left != null && left <= 0) {
    b.hidden = false; b.className = 'banner error';
    b.textContent = `Your Terra token expired ${when(s.terraTokenExpires)}. ${tokenFix(s)}`;
  } else if (s.error) {
    b.hidden = false; b.className = 'banner error';
    b.textContent = `Terra: ${s.error}`;
  } else if (left != null && left < 24 * 3600e3) {
    b.hidden = false; b.className = 'banner';
    b.textContent = `Your Terra token expires ${when(s.terraTokenExpires)}. ${tokenFix(s)}`;
  } else b.hidden = true;
}

const tokenFix = (s) => (s.terraTokenFrom === 'env'
  ? 'Get a new one from terra.hackclub.com and update TERRA_TOKEN where Blanche is hosted.'
  : 'Get a new one from terra.hackclub.com and paste it in Settings.');
function tokenPill(s) {
  if (!s.terraTokenExpires) return null;
  const ms = Date.parse(s.terraTokenExpires) - Date.now();
  const h = ms / 3600e3;
  const text = ms <= 0 ? 'token expired' : h < 24 ? `token: ${Math.max(1, Math.floor(h))}h left` : `token: ${Math.floor(h / 24)}d ${Math.floor(h % 24)}h left`;
  return el('span', { class: `tok${ms <= 0 ? ' bad' : h < 48 ? ' soon' : ''}`, title: `Terra token expires ${new Date(s.terraTokenExpires).toLocaleString()}` }, text);
}
// keep the countdown current without a reload
setInterval(() => { if (state.status && state.status.terraTokenExpires) loadStatus().catch(() => {}); }, 30 * 60e3);

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
  const tab = state.verdictTab || (['changes', 'reject', 'fraud'].includes(a.verdict) ? a.verdict : 'approve');
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
      a.before ? el('span', { class: 'was' }, `Blanche said ${VERDICT_LABEL[a.before.verdict]} · ${a.ignoredCount} ignored`) : null,
      el('span', {}, `scanned ${new Date(a.analyzedAt).toLocaleTimeString()}`)));

  const L = a.links;
  const links = el('div', { class: 'links' },
    ext(L.terra, 'Open in Terra'),
    L.repo ? ext(L.repo, 'Repo') : null,
    L.demo ? ext(L.demo, 'Demo') : null,
    L.verlock ? ext(L.verlock, 'Open in Verlock', 'verlock') : null,
    el('button', { onclick: () => rescan(a.sid) }, 'Rescan'));

  const findings = el('div', { class: 'card' }, el('h3', {}, `Findings (${a.findings.length})`),
    a.findings.length ? el('ul', { class: 'findings' }, a.findings.map((f) => findingRow(a, f)))
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

  $('#detail').replaceChildren(head, links, el('div', { class: 'grid' }, el('div', {}, reshipCard(a), findings, facts), decideCard(a, tab)), evidenceCard(a), historyCard(a));
}

// ---------- re-ships ----------
const TOPIC_STATUS = { flagged: ['Still flagged', 'changes'], ok: ['Blanche finds nothing now', 'clean'], check: ['Check by hand', 'warn'], ignored: ['Flagged, you ignored it', 'none'] };
function reshipCard(a) {
  const r = a.reship;
  if (!r) return null;
  const ignored = new Set(a.findings.filter((f) => f.ignored).map((f) => f.id));
  const long = r.last.note.length > 700;
  const noteEl = el('p', { class: 'rnote' }, long ? `${r.last.note.slice(0, 700)}…` : r.last.note || '(no note)');
  const more = long ? el('button', { class: 'link', onclick: (e) => { noteEl.textContent = r.last.note; e.target.remove(); } }, 'Show all') : null;
  const sinceBtn = el('button', { class: 'link', onclick: () => { state.historyView = 'since'; renderDetail(); document.querySelector('.history')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
    `${r.newCommits} commit${r.newCommits === 1 ? '' : 's'} and ${r.newJournals.length} journal${r.newJournals.length === 1 ? '' : 's'} since then`);
  return el('div', { class: 'card reship' },
    el('h3', {}, `Re-ship · ${a.ship.changesRounds || 1} change round${(a.ship.changesRounds || 1) === 1 ? '' : 's'} before`),
    el('div', { class: 'rmeta' }, `Last request ${when(r.last.at)}${r.last.reviewer ? ` by ${r.last.reviewer}` : ''}`),
    noteEl, more,
    r.topics.length
      ? el('ul', { class: 'topics' }, r.topics.map((t) => {
        const st = t.status === 'flagged' && t.findings.every((id) => ignored.has(id)) ? 'ignored' : t.status;
        return el('li', {},
          el('span', { class: 'tl' }, t.label),
          el('span', { class: `tag ${TOPIC_STATUS[st][1]}` }, TOPIC_STATUS[st][0]),
          el('span', { class: 'tn' }, [t.titles.length ? t.titles.join(' · ') : null, t.now].filter(Boolean).join(' — ')));
      }))
      : el('p', { class: 'muted small' }, "Blanche couldn't tell what was asked from the note, so read it and check by hand."),
    el('div', { class: 'rsince' }, r.noCommitsSince ? el('span', { class: 'tag changes' }, 'No commits since the request') : null, ' ', sinceBtn),
    r.earlier.length ? el('details', { class: 'earlier' }, el('summary', {}, `Earlier decisions (${r.earlier.length})`),
      el('ul', {}, r.earlier.map((x) => el('li', {}, el('strong', {}, x.label), ` · ${when(x.at)}${x.reviewer ? ` · ${x.reviewer}` : ''}`,
        x.note ? el('p', { class: 'rnote' }, x.note) : null)))) : null);
}

// ---------- commit evidence (Introspect-style) ----------
const KIND_TAG = {
  'web-upload': ['web upload', 'Uploaded through GitHub\'s website ("Add files via upload")'],
  readme: ['README', 'Only touches the README'],
  vague: ['vague', 'The message says little about the change'],
  merge: ['merge', 'Merge commit'],
};
const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) n.append(k instanceof Node ? k : String(k));
  return n;
}
const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

// One single-series daily bar chart. Both charts share the same day slots so they line up; hovering a
// day in either highlights it in both and fills the shared tooltip.
function dayBars(days, { value, fmt, color, title, height = 120, onHover, integer = false }) {
  // draw at the width the card really has, so text stays at its real size on a phone
  const avail = (document.querySelector('#detail')?.clientWidth || 760) - 90;
  const W = Math.max(280, Math.min(1100, avail)), padL = 34, padR = 6, padT = 8, padB = 18, H = height;
  const top = Math.max(...days.map(value), 0);
  const max = integer ? Math.max(2, Math.ceil(niceMax(top))) : niceMax(top);
  const slot = (W - padL - padR) / Math.max(1, days.length);
  const bw = Math.max(2, Math.min(28, slot - 2)); // 2px gap between neighbours
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const base = H - padB;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'bars', role: 'img', 'aria-label': title });
  for (const t of (integer && max % 2 ? [0, max] : [0, max / 2, max])) {
    root.append(svg('line', { x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: 'grid' }),
      svg('text', { x: padL - 6, y: y(t) + 4, class: 'tick', 'text-anchor': 'end' }, fmt(t, true)));
  }
  const hl = svg('rect', { y: padT, height: base - padT, width: slot, class: 'hl', visibility: 'hidden' });
  root.append(hl);
  days.forEach((d, i) => {
    const v = value(d);
    const x = padL + i * slot + (slot - bw) / 2;
    if (v > 0) {
      const yt = y(v), r = Math.min(4, bw / 2, base - yt);
      root.append(svg('path', { class: 'bar', fill: color,
        d: `M${x},${base} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + bw - r} Q${x + bw},${yt} ${x + bw},${yt + r} V${base} Z` }));
    }
  });
  root.append(svg('line', { x1: padL, x2: W - padR, y1: base, y2: base, class: 'axis' }));
  const every = Math.ceil(days.length / Math.max(2, Math.floor(W / 90)));
  days.forEach((d, i) => {
    if (i % every && i !== days.length - 1) return;
    root.append(svg('text', { x: padL + i * slot + slot / 2, y: H - 4, class: 'tick', 'text-anchor': 'middle' }, shortDay(d.date)));
  });
  // hit targets: the whole day column, wider than the bar
  days.forEach((d, i) => root.append(svg('rect', { x: padL + i * slot, y: 0, width: slot, height: base, class: 'hit',
    onmouseenter: null })));
  root.querySelectorAll('rect.hit').forEach((r, i) => {
    r.addEventListener('mouseenter', (e) => onHover(i, e));
    r.addEventListener('mousemove', (e) => onHover(i, e));
    r.addEventListener('mouseleave', () => onHover(-1));
  });
  root.highlight = (i) => {
    if (i < 0) return hl.setAttribute('visibility', 'hidden');
    hl.setAttribute('x', padL + i * slot);
    hl.setAttribute('visibility', 'visible');
  };
  return root;
}

function evidenceCard(a) {
  const E = a.evidence;
  if (!E || (!E.counts.total && !E.trackedSeconds)) return null;
  const n = E.counts;
  const claimed = a.ship.seconds || 0;
  const tile = (label, val, sub, warn) => el('div', { class: `tile${warn ? ' warn' : ''}` }, el('div', { class: 'tv' }, val), el('div', { class: 'tl' }, label), sub ? el('div', { class: 'ts' }, sub) : null);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const ids = new Set(a.findings.filter((f) => !f.ignored).map((f) => f.id));
  const tiles = el('div', { class: 'tiles' },
    tile('Commits', n.total, `${n.content + n.vague} code${n.readme ? ` · ${n.readme} README` : ''}${n.merge ? ` · ${n.merge} merge` : ''}`),
    tile('Per claimed hour', E.perHour != null ? E.perHour.toFixed(2) : '—', `code commits over ${hours(claimed)}`, ids.has('few-commits')),
    tile('Biggest commit', E.largest ? pct(E.largest.share) : '—', E.largest ? `of changed lines · ${E.largest.sha.slice(0, 7)}` : 'no code commits', ids.has('mega-commit')),
    tile('Web uploads', n['web-upload'], n.total ? `${pct(n['web-upload'] / n.total)} of commits` : '', ids.has('web-uploads')),
    tile('Vague messages', n.vague, n.total ? `${pct(n.vague / n.total)} of commits` : '', ids.has('vague-messages')),
    tile('Busiest day', E.busiest ? pct(E.busiest.share) : '—', E.busiest ? `of lines, ${shortDay(E.busiest.date)}` : ''),
    tile('Coding time', hours(E.trackedSeconds), `on ${E.codingDays} day${E.codingDays === 1 ? '' : 's'} · commits on ${E.commitDays}`),
    tile('No-commit days', hours(E.quietSeconds), E.trackedSeconds ? `${pct(E.quietSeconds / E.trackedSeconds)} of coding time` : '', ids.has('time-without-commits')));

  const days = E.days;
  const mode = state.evidenceMode || 'count';
  const tip = el('div', { class: 'vtip', role: 'status', hidden: true });
  const charts = [];
  const hover = (i, e) => {
    charts.forEach((c) => c.highlight(i));
    if (i < 0) { tip.hidden = true; return; }
    const d = days[i];
    tip.replaceChildren(el('strong', {}, shortDay(d.date)),
      el('div', {}, el('span', { class: 'sw s1' }), `Coding ${hours(d.seconds)}`),
      el('div', {}, el('span', { class: 'sw s2' }), `${d.commits} commit${d.commits === 1 ? '' : 's'} · ${d.lines} lines`));
    tip.hidden = false;
    const box = wrap.getBoundingClientRect();
    const x = e.clientX - box.left, yy = e.clientY - box.top;
    tip.style.left = `${Math.min(box.width - 170, Math.max(0, x + 12))}px`;
    tip.style.top = `${yy + 12}px`;
  };
  const time = dayBars(days, { value: (d) => d.seconds / 3600, fmt: (v, tick) => `${tick ? +v.toFixed(1) : v.toFixed(1)}h`, color: 'var(--series-1)', title: 'Coding time per day', onHover: hover });
  const work = dayBars(days, { value: (d) => (mode === 'lines' ? d.lines : d.commits), fmt: (v) => `${Math.round(v)}`, color: 'var(--series-2)', title: mode === 'lines' ? 'Lines changed per day' : 'Commits per day', onHover: hover, height: 100, integer: true });
  charts.push(time, work);
  const toggle = el('div', { class: 'tabs seg', role: 'group', 'aria-label': 'Commit measure' },
    [['count', 'Commits'], ['lines', 'Lines']].map(([k, label]) =>
      el('button', { 'aria-pressed': String(mode === k), onclick: () => { state.evidenceMode = k; renderDetail(); } }, label)));
  const wrap = el('div', { class: 'vwrap' },
    el('div', { class: 'vlabel' }, el('span', { class: 'sw s1' }), 'Coding time per day (Hackatime)'), time,
    el('div', { class: 'vlabel' }, el('span', { class: 'sw s2' }), mode === 'lines' ? 'Lines changed per day' : 'Commits per day', toggle), work,
    tip);
  const table = el('details', { class: 'vtable' }, el('summary', {}, 'Show as a table'),
    el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Day'), el('th', {}, 'Coding'), el('th', {}, 'Commits'), el('th', {}, 'Lines'))),
      el('tbody', {}, days.map((d) => el('tr', { class: d.seconds && !d.commits ? 'quiet' : null },
        el('td', {}, shortDay(d.date)), el('td', {}, hours(d.seconds)), el('td', {}, d.commits), el('td', {}, d.lines))))));

  return el('div', { class: 'card evidence' },
    el('div', { class: 'hh' }, el('h3', {}, 'Commit evidence'), el('span', { class: 'muted small' }, `vs ${hours(claimed)} claimed${E.truncated ? ' · Terra cut the commit list short' : ''}`)),
    tiles,
    days.length ? wrap : el('p', { class: 'muted small' }, 'No daily data from Terra for this ship.'),
    days.length ? table : null);
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

  const sinceAt = a.reship ? Date.parse(a.reship.last.at) : null;
  const toggle = el('div', { class: 'tabs seg', role: 'group', 'aria-label': 'History view' },
    [['journal', 'By journal'], ['history', 'Commit history'], ...(a.reship ? [['since', 'Since request']] : [])].map(([k, label]) =>
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
  } else if (view === 'since' && sinceAt) {
    const nc = commits.filter((c) => Date.parse(c.committedAt) > sinceAt);
    const nj = journals.map((j, i) => ({ ...j, n: i + 1 })).filter((j) => Date.parse(j.createdAt) > sinceAt);
    body = el('div', {},
      el('p', { class: 'muted small' }, `Since the changes request on ${when(a.reship.last.at)}:`),
      nj.length ? nj.map((j) => el('section', { class: 'journal' },
        el('div', { class: 'jh' }, el('span', { class: 'jn' }, `#${j.n}`), el('strong', {}, j.title || '(untitled journal)'), el('span', { class: 'muted' }, `${when(j.createdAt)} · ${hours(j.creditedSeconds)}`)),
        j.body ? el('p', { class: 'jb' }, j.body) : null)) : el('p', { class: 'muted small' }, 'No new journals.'),
      nc.length ? el('div', { class: 'commits' }, nc.map((c) => commitRow(a, c, c.journalId ? byId.get(c.journalId) : null, true)))
        : el('p', { class: 'muted small' }, 'No new commits.'));
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
    KIND_TAG[a.evidence?.kinds?.[c.sha]] ? el('span', { class: `ktag ${a.evidence.kinds[c.sha]}`, title: KIND_TAG[a.evidence.kinds[c.sha]][1] }, KIND_TAG[a.evidence.kinds[c.sha]][0]) : null,
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

// One finding. Blocking ones (changes / reject / fraud) can be ignored when Blanche got it wrong; an
// ignored finding stops counting toward the verdict and can be undone.
const BLOCKING = ['changes', 'reject', 'fraud'];
function findingRow(a, f) {
  const ignorable = BLOCKING.includes(f.verdict);
  const act = el('span', { class: 'fa' });
  const ignore = (reason) => setIgnore(a, f.id, true, reason);
  if (f.ignored) {
    act.append(el('button', { class: 'link', onclick: () => setIgnore(a, f.id, false) }, 'Undo'));
  } else if (ignorable) {
    act.append(el('button', { class: 'link', title: 'Blanche got this one wrong: stop counting it', onclick: () => {
      const input = el('input', { type: 'text', placeholder: 'Why? (optional)', 'aria-label': `Why ignore "${f.title}"`, maxlength: 500,
        onkeydown: (e) => { if (e.key === 'Enter') ignore(input.value); if (e.key === 'Escape') renderDetail(); } });
      act.replaceChildren(input, el('button', { onclick: () => ignore(input.value) }, 'Ignore'), el('button', { class: 'link', onclick: () => renderDetail() }, 'Cancel'));
      input.focus();
    } }, 'Ignore'));
  }
  return el('li', { class: `${f.verdict}${f.ignored ? ' ignored' : ''}` },
    el('div', { class: 'ft' }, el('span', { class: `tag ${f.verdict}` }, VERDICT_LABEL[f.verdict]), el('span', { class: 'fx' }, f.title),
      el('span', { class: 'conf' }, f.confidence), f.ignored ? el('span', { class: 'tag none' }, 'ignored') : null, act),
    f.ignored && f.ignored.reason ? el('div', { class: 'fd' }, `Ignored: ${f.ignored.reason}`) : null,
    f.detail ? el('div', { class: 'fd' }, f.detail) : null,
    f.guideline ? el('div', { class: 'fg' }, ext(f.guideline.url, f.guideline.title)) : null);
}

async function setIgnore(a, findingId, ignore, reason) {
  try {
    const v = await api(`/api/ignore/${a.sid}`, { method: 'POST', body: { findingId, ignore, reason } });
    state.analyses.set(a.sid, v);
    // once nothing blocks any more, the natural next step is approving
    if (ignore && !v.problems.approve.length && v.verdict === 'clean') state.verdictTab = 'approve';
    render(); renderDetail();
  } catch (e) { toast(e.message, true); }
}

function decideCard(a, tab) {
  const dry = state.status.dryRun;
  const tabs = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Decision' },
    [['approve', 'Approve'], ['changes', 'Request changes'], ['reject', 'Reject'], ['fraud', 'Move to fraud']].map(([k, label]) =>
      el('button', { class: k === 'approve' ? 'clean' : k, 'aria-pressed': String(tab === k), onclick: () => { state.verdictTab = k; renderDetail(); } }, label)));
  if (tab === 'approve') return el('div', { class: 'card decide' }, el('h3', {}, 'Decide'), tabs, approveForm(a));
  const note = el('textarea', { id: 'note', 'aria-label': tab === 'fraud' ? 'Move note' : 'Note to the player' });
  note.value = a.notes[tab] || '';
  const internal = tab === 'fraud' ? null : el('textarea', { id: 'internal', class: 'small', 'aria-label': 'Internal note' });
  const problems = a.problems[tab] || [];
  const out = el('div');
  const btn = el('button', { class: 'primary', onclick: () => decide(a, tab, { note: note.value, internalNote: internal && internal.value }, btn, out) },
    `${dry ? 'Preview' : 'Send'} ${tab === 'changes' ? 'changes' : tab === 'reject' ? 'rejection' : 'to fraud'}`);
  return el('div', { class: 'card decide' }, el('h3', {}, 'Decide'), tabs,
    problems.length ? el('div', { class: 'problems' }, `Terra won't take this right now: ${problems.join('; ')}.`) : null,
    tab === 'reject' ? el('div', { class: 'problems' }, 'A rejection is final: the player can\'t reship this project.') : null,
    el('label', { for: 'note' }, tab === 'fraud' ? 'Move note (for the fraud team)' : 'Note to the player'), note,
    internal ? [el('label', { for: 'internal' }, 'Internal note (staff only, optional)'), internal] : null,
    el('div', { class: 'act' }, btn, el('span', { class: 'hint' }, dry ? 'Dry run: shows the requests without sending them.' : 'Live: claims the ship and sends the decision to Terra.')),
    out);
}

// What the reviewer typed into the approve form, kept per ship so switching tabs or ignoring a finding
// doesn't throw it away. The chosen video File lives here too (uploaded to Blanche only when sent).
const drafts = new Map();
function approveForm(a) {
  const need = a.approve;
  const dry = state.status.dryRun;
  const d = drafts.get(a.sid) || {
    builtWhat: need.builtWhat, projectReview: need.projectReview || '', updateJustification: '', flagReasons: {},
    multiplier: need.multiplier, deflationHours: +(need.deflationSeconds / 3600).toFixed(2), deflationReason: need.deflationReason,
    note: need.noteToMaker, file: null, videoId: null,
  };
  drafts.set(a.sid, d);
  const problems = a.problems.approve || [];
  const count = (min, max) => (v) => `${v.trim().length}${max ? ` / ${max}` : ''} · needs ${min}+`;
  const field = (id, label, key, { min, max, area = true, hint } = {}) => {
    const c = count(min, max);
    const help = el('small', { class: 'count' }, min ? c(d[key] || '') : hint || '');
    const input = el(area ? 'textarea' : 'input', { id, class: area ? 'mid' : null, type: area ? null : 'text', oninput: (e) => { d[key] = e.target.value; if (min) help.textContent = c(e.target.value); } });
    input.value = d[key] || '';
    return [el('label', { for: id }, label), input, help];
  };
  const flags = need.dangerFlags.map((f) => {
    const id = `ack-${f.kind}`;
    const input = el('input', { id, type: 'text', placeholder: 'Why this is fine (10+ characters)', oninput: (e) => { d.flagReasons[f.kind] = e.target.value; } });
    input.value = d.flagReasons[f.kind] || '';
    return [el('label', { for: id }, `Acknowledge Terra flag: ${f.title}`), input];
  });
  const fileLabel = el('small', { class: 'count' }, d.file ? `${d.file.name} · ${(d.file.size / 1048576).toFixed(1)} MB` : need.videoOptional ? 'Optional for your account.' : 'Required for your account. MP4, WebM or MOV, under 100 MB.');
  const fileInput = el('input', { id: 'video', type: 'file', accept: 'video/mp4,video/webm,video/quicktime', onchange: (e) => {
    const f = e.target.files[0] || null;
    if (f && f.size > 104857600) { toast('The video has to be under 100 MB.', true); e.target.value = ''; return; }
    d.file = f; d.videoId = null;
    fileLabel.textContent = f ? `${f.name} · ${(f.size / 1048576).toFixed(1)} MB` : '';
  } });
  const num = (id, key, attrs) => {
    const i = el('input', { id, type: 'number', ...attrs, oninput: (e) => { d[key] = e.target.value; } });
    i.value = d[key];
    return i;
  };
  const out = el('div');
  const btn = el('button', { class: 'primary approve', disabled: problems.length > 0, onclick: () => decide(a, 'approve', d, btn, out) },
    dry ? 'Preview approval' : 'Approve');
  return el('div', { class: 'approve-form' },
    problems.length ? el('div', { class: 'problems' }, `Can't approve yet: ${problems.join('; ')}.`) : null,
    a.before ? el('p', { class: 'hint' }, `You're overriding Blanche: it said ${VERDICT_LABEL[a.before.verdict]}${a.before.easy ? ' (easy)' : ''}.`) : null,
    el('label', { for: 'video' }, 'Test video'), fileInput, fileLabel,
    field('built', 'What they built (shown in Airtable)', 'builtWhat', { min: 30, max: 1000 }),
    field('review', 'Justification: how you tested it and why it passes', 'projectReview', { min: 80 }),
    need.needsUpdateJustification ? field('update', 'Update justification (the repo was also submitted to another program)', 'updateJustification', { min: 40 }) : null,
    flags,
    el('div', { class: 'row2' },
      el('div', {}, el('label', { for: 'mult' }, 'Payout multiplier'), num('mult', 'multiplier', { min: 0.8, max: 1.5, step: 0.01 }),
        el('small', { class: 'count' }, `0.8–1.5 · community vote suggests ${need.multiplier}`)),
      el('div', {}, el('label', { for: 'defl' }, 'Cut hours'), num('defl', 'deflationHours', { min: 0, max: +(need.creditedSeconds / 3600).toFixed(2), step: 0.1 }),
        el('small', { class: 'count' }, `of ${hours(need.creditedSeconds)} credited`))),
    field('deflr', 'Reason for the cut (if any)', 'deflationReason', { area: false }),
    field('anote', 'Note to the player', 'note', {}),
    el('div', { class: 'act' }, btn, el('span', { class: 'hint' }, dry ? 'Dry run: shows the requests without sending them.' : 'Live: claims the ship, acknowledges flags, uploads the video and approves.')),
    out);
}

async function stageVideo(a, d) {
  if (!d.file || d.videoId) return;
  const r = await fetch(`/api/video/${a.sid}`, { method: 'POST', headers: { 'Content-Type': d.file.type || 'video/mp4', 'X-Blanche': '1' }, body: d.file });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Video upload to Blanche failed (HTTP ${r.status})`);
  d.videoId = data.id;
}

async function decide(a, verdict, input, btn, out) {
  const dry = state.status.dryRun;
  if (!dry && verdict === 'reject' && !confirm(`Reject "${a.ship.title}" for good?`)) return;
  if (!dry && verdict === 'approve' && !confirm(`Approve "${a.ship.title}" at ${input.multiplier}x${Number(input.deflationHours) > 0 ? `, cutting ${input.deflationHours}h` : ''}?`)) return;
  btn.disabled = true;
  const label = btn.textContent;
  try {
    let body;
    if (verdict === 'approve') {
      if (input.file && !input.videoId) btn.textContent = 'Uploading video…';
      await stageVideo(a, input);
      body = { verdict, note: input.note, dryRun: dry, evidenceVersion: a.evidenceVersion, form: {
        builtWhat: input.builtWhat, projectReview: input.projectReview, updateJustification: input.updateJustification,
        flagReasons: input.flagReasons, multiplier: Number(input.multiplier),
        deflationSeconds: Math.round(Number(input.deflationHours || 0) * 3600), deflationReason: input.deflationReason, videoId: input.videoId,
      } };
    } else {
      body = { verdict, note: input.note, internalNote: input.internalNote, dryRun: dry, evidenceVersion: a.evidenceVersion };
    }
    btn.textContent = label;
    const r = await api(`/api/decide/${a.sid}`, { method: 'POST', body });
    if (r.dryRun) {
      out.replaceChildren(el('p', { class: 'hint' }, 'Dry run. These requests would be sent, in order:'),
        el('pre', { class: 'steps' }, r.steps.map((s) => s.method === 'UPLOAD'
          ? `POST ${s.path}\n(multipart: the test video, ${(s.video.size / 1048576).toFixed(1)} MB ${s.video.type})`
          : `${s.method} ${s.path}\n${JSON.stringify(s.body, null, 2)}`).join('\n\n')));
    } else {
      toast(`${{ fraud: 'Moved to fraud', reject: 'Rejected', changes: 'Changes requested', approve: 'Approved' }[verdict]}: ${a.ship.title}`);
      drafts.delete(a.sid);
      state.items = state.items.filter((i) => i.id !== a.sid);
      state.analyses.delete(a.sid);
      const next = visible()[0];
      if (next) select(next.id); else { state.selected = null; render(); $('#detail').replaceChildren(el('p', { class: 'empty' }, 'Bucket cleared.')); }
    }
  } catch (e) {
    if (verdict === 'approve' && /expired/.test(e.message)) input.videoId = null; // re-upload next time
    toast(e.message, true);
  } finally { btn.textContent = label; btn.disabled = verdict === 'approve' && (a.problems.approve || []).length > 0; }
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
  else if (e.key === 'i' && state.selected) {
    // ignore the top finding that still counts: opens its reason box
    const b = [...document.querySelectorAll('.findings li:not(.ignored) .fa button.link')].find((x) => x.textContent === 'Ignore');
    if (!b) { toast('Nothing left to ignore on this ship.'); return e.preventDefault(); }
    b.click();
  } else if (e.key === 'a' && state.selected) {
    state.verdictTab = 'approve'; renderDetail();
    document.querySelector('.approve-form')?.scrollIntoView({ block: 'nearest' });
    (document.querySelector('#review') || document.querySelector('#video'))?.focus();
  } else if (e.key === 'n' && state.selected) {
    // press the decision button: in dry run that previews, live it sends and moves to the next ship
    const b = document.querySelector('.decide .act button.primary');
    if (!b || b.disabled) { toast(b ? 'Fix what the Decide card lists first.' : 'Nothing to send.', true); return e.preventDefault(); }
    b.click();
  }
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
