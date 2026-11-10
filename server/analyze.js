// Gathers everything about one ship (Terra + GitHub + the live demo link), runs the rules,
// and builds the requests for a decision.
const { evaluate, summarize, composeNote, classifyDemo } = require('./rules');

function buildCase(d, repo, demoCheck) {
  const s = d.shipment || {};
  const p = d.project || {};
  const m = d.maker || {};
  const ev = (d.evidence && d.evidence.data) || {};
  const t = ev.time || {};
  return {
    sid: s.id,
    projectId: s.projectId,
    title: s.title || p.title,
    username: m.username,
    githubLogin: m.githubLogin,
    weekNumber: s.weekNumber,
    seconds: t.creditedSeconds || s.hackatimeSeconds || 0,
    platforms: s.platforms || [],
    description: p.description,
    shipNotes: s.notes,
    aiDeclaration: s.aiDeclaration,
    codeUrl: p.codeUrl,
    demoUrl: p.demoUrl,
    screenshotUrl: p.screenshotUrl,
    isUpdate: !!p.isUpdate,
    changesRounds: s.changesRounds || 0,
    flags: d.flags || [],
    fraudSuggestion: d.fraudSuggestion || null,
    unifiedUrlMatches: ev.unifiedUrlMatches || [],
    commits: ev.commits || [],
    files: ev.files || [],
    sessions: ev.sessions || [],
    time: { totalSeconds: t.totalSeconds || s.hackatimeSeconds || 0, aiSeconds: t.aiSeconds || s.aiSeconds || 0 },
    repo: repo || {},
    demoCheck: demoCheck || null,
  };
}

// Why Terra's review page wouldn't let you decide this ship right now.
function shipProblems(d, verdict) {
  const s = d.shipment || {};
  const v = d.viewer || {};
  const p = [];
  if (!v.canReview) p.push("your account can't review");
  if (v.isOwner && !v.isAdmin) p.push("it's your own ship");
  if (s.stage && s.stage !== 'review') p.push(`it's at stage "${s.stage}", not review`);
  if (s.reviewHold) p.push(`it's on hold (${s.reviewHold})`);
  const ev = d.evidence || {};
  if (!ev.data || ev.version !== s.evidenceVersion) p.push('evidence is still being built');
  const claim = (d.claims || {}).review;
  if (claim && !claim.mine && !claim.stale) p.push(`${claim.username || 'someone'} has it claimed`);
  if (verdict === 'changes' && (s.changesRounds || 0) >= 3 && !v.isAdmin) p.push('it already had 3 rounds of changes, so only approve/reject is left');
  if (verdict === 'fraud' && !s.fraudPending) p.push('fraud already gave a verdict, so it can only go to an admin');
  return p;
}

// What an approval needs, from the ship as Terra has it now (see docs: "Review rules the page enforces").
const BLOCKING = ['changes', 'reject', 'fraud'];
function approveNeeds(d) {
  const s = d.shipment || {};
  const ev = (d.evidence && d.evidence.data) || {};
  const sm = Number((d.votes || {}).suggestedMultiplier);
  const fs = d.fraudSuggestion;
  return {
    videoOptional: !!(d.viewer || {}).videoOptional,
    multiplier: Number.isFinite(sm) ? Math.min(1.5, Math.max(0.8, Math.round(sm * 100) / 100)) : 1,
    creditedSeconds: (ev.time || {}).creditedSeconds || s.hackatimeSeconds || 0,
    dangerFlags: (d.flags || []).filter((f) => f.severity === 'danger' && !f.dismissedAt && f.kind !== 'double_dip')
      .map((f) => ({ kind: f.kind, title: f.title || f.kind })),
    needsUpdateJustification: (ev.unifiedUrlMatches || []).length > 0,
    deflationSeconds: fs && fs.seconds > 0 ? fs.seconds : 0,
    deflationReason: fs && fs.seconds > 0 ? `Fraud review: ${fs.reason || ''}`.trim() : '',
  };
}

// Checks an approval the way Terra's review page does, plus Blanche's own rule: every blocking finding
// has to be ignored first. -> list of problems (empty = ok)
function approveProblems(d, b, { blocking = [] } = {}) {
  const need = approveNeeds(d);
  const p = [];
  if (blocking.length) p.push(`Blanche still flags it (${blocking.join('; ')}): ignore those findings first`);
  const m = Number(b.multiplier);
  if (!(m >= 0.8 && m <= 1.5)) p.push('the multiplier has to be between 0.8 and 1.5');
  const built = String(b.builtWhat || '').trim();
  if (built.length < 30 || built.length > 1000) p.push('"What they built" needs 30 to 1000 characters');
  if (String(b.projectReview || '').trim().length < 80) p.push('the justification needs 80+ characters');
  if (need.needsUpdateJustification && String(b.updateJustification || '').trim().length < 40) {
    p.push('the repo was also submitted to another program, so the update justification needs 40+ characters');
  }
  const acks = b.flagReasons || {};
  for (const f of need.dangerFlags) {
    if (String(acks[f.kind] || '').trim().length < 10) p.push(`acknowledge the "${f.title}" flag (10+ characters)`);
  }
  const defl = Number(b.deflationSeconds || 0);
  if (!(defl >= 0) || defl > need.creditedSeconds) p.push('the hours cut has to be between 0 and the credited hours');
  if (defl > 0 && String(b.deflationReason || '').trim().length < 1) p.push('give a reason for the hours cut');
  if (!need.videoOptional && !b.video) p.push('Terra needs a test video for your account: attach one');
  return p;
}

function decisionSteps(d, verdict, { note, internalNote, form }) {
  const s = d.shipment;
  const sid = s.id;
  const claim = { method: 'POST', path: `/review/shipment/${sid}/claim`, body: { queue: 'review', takeover: false } };
  if (verdict === 'fraud' || verdict === 'admin') {
    return [claim, { method: 'POST', path: `/review/shipment/${sid}/send`, body: { hold: verdict, note } }];
  }
  if (verdict === 'changes' || verdict === 'reject') {
    return [claim, { method: 'POST', path: `/review/shipment/${sid}/${verdict}`,
      body: { evidenceVersion: s.evidenceVersion, noteToMaker: note, videoUrl: null, internalNote: internalNote || '' } }];
  }
  if (verdict === 'approve') {
    const need = approveNeeds(d);
    const b = form || {};
    const defl = Math.round(Number(b.deflationSeconds || 0));
    return [
      claim,
      ...need.dangerFlags.map((f) => ({ method: 'POST', path: `/review/shipment/${sid}/flags/${encodeURIComponent(f.kind)}/dismiss`,
        body: { reason: String((b.flagReasons || {})[f.kind] || '').trim() } })),
      ...(b.video ? [{ method: 'UPLOAD', path: `/review/shipment/${sid}/video`, video: b.video }] : []),
      { method: 'POST', path: `/review/shipment/${sid}/approve`, body: {
        evidenceVersion: s.evidenceVersion,
        deflationSeconds: defl, cropDeflationSeconds: defl,
        deflationReason: defl > 0 ? String(b.deflationReason || '').trim() : '',
        payoutMultiplier: Number(b.multiplier),
        noteToMaker: note,
        videoUrl: b.video ? '<from the video upload>' : null,
        builtWhat: String(b.builtWhat).trim(),
        projectReview: String(b.projectReview).trim(),
        updateJustification: need.needsUpdateJustification ? String(b.updateJustification || '').trim() : '',
      } },
    ];
  }
  throw new Error(`unknown verdict ${verdict}`);
}

class Analyzer {
  constructor({ terra, github, checkDemo, settings, ignores }) {
    this.terra = terra;
    this.github = github;
    this.checkDemo = checkDemo;
    this.settings = settings;
    this.cache = new Map(); // sid -> result as the rules found it
    this.cases = new Map(); // sid -> the case the rules ran on (to redo notes after an ignore)
    this.ignores = ignores || { get: () => ({}) }; // sid -> { findingId: { reason, at } }
  }

  // The result with the reviewer's ignored findings taken out of the verdict. Ignored findings stay in the
  // list (marked) so they can be undone.
  view(sid) {
    const out = this.cache.get(sid);
    if (!out) return null;
    const ign = this.ignores.get(sid) || {};
    const findings = out.findings.map((f) => (ign[f.id] ? { ...f, ignored: ign[f.id] } : f));
    const live = findings.filter((f) => !f.ignored);
    const r = summarize(live.slice(), this.cases.get(sid));
    const c = this.cases.get(sid);
    const opts = this.settings();
    const blocking = live.filter((f) => BLOCKING.includes(f.verdict));
    return {
      ...out, findings, verdict: r.verdict, easy: r.easy, top: r.top,
      ignoredCount: findings.length - live.length,
      before: findings.length !== live.length ? { verdict: out.verdict, easy: out.easy } : null,
      problems: { ...out.problems, approve: [...out.problems.approve, ...(blocking.length ? [`Blanche still flags it: ignore ${blocking.length === 1 ? 'that finding' : `those ${blocking.length} findings`} first`] : [])] },
      notes: {
        ...out.notes,
        changes: composeNote({ ...r, findings: live, verdict: 'changes' }, c, opts),
        reject: composeNote({ ...r, findings: live, verdict: 'reject' }, c, opts),
        fraud: composeNote({ ...r, findings: live, verdict: 'fraud' }, c, opts),
      },
    };
  }

  blockingFindings(sid) {
    const v = this.view(sid);
    return v ? v.findings.filter((f) => !f.ignored && BLOCKING.includes(f.verdict)).map((f) => f.title) : [];
  }

  async analyze(sid, { fresh = false } = {}) {
    if (!fresh && this.cache.has(sid)) return this.view(sid);
    const d = await this.terra.shipment(sid);
    const p = d.project || {};
    const demo = classifyDemo(p.demoUrl);
    const [repo, demoCheck] = await Promise.all([
      p.codeUrl ? this.github.repo(p.codeUrl) : Promise.resolve({ status: 'none' }),
      ['web', 'binary', 'store', 'video'].includes(demo.kind) ? this.checkDemo(demo.url) : Promise.resolve(null),
    ]);
    const c = buildCase(d, repo, demoCheck);
    const opts = this.settings();
    const result = evaluate(c, opts);
    const jc = journalsAndCommits(d);
    const out = {
      sid,
      analyzedAt: new Date().toISOString(),
      evidenceVersion: (d.shipment || {}).evidenceVersion,
      ship: {
        title: c.title, username: c.username, githubLogin: c.githubLogin, weekNumber: c.weekNumber, seconds: c.seconds,
        platforms: c.platforms, description: c.description, shipNotes: c.shipNotes, aiDeclaration: c.aiDeclaration,
        codeUrl: c.codeUrl, demoUrl: c.demoUrl, screenshotUrl: c.screenshotUrl, isUpdate: c.isUpdate,
        changesRounds: c.changesRounds, projectId: c.projectId,
      },
      demo: { ...demo, check: demoCheck },
      repo: summarizeRepo(repo),
      ...jc,
      reship: reshipCheck(d, result.findings, summarizeRepo(repo), demoCheck, jc),
      problems: { changes: shipProblems(d, 'changes'), reject: shipProblems(d, 'reject'), fraud: shipProblems(d, 'fraud'), approve: shipProblems(d, 'approve') },
      approve: { ...approveNeeds(d), builtWhat: (c.description || '').trim().slice(0, 1000), noteToMaker: approveNote(c, opts) },
      ...result,
      notes: {
        changes: composeNote({ ...result, verdict: 'changes' }, c, opts),
        reject: composeNote({ ...result, verdict: 'reject' }, c, opts),
        fraud: composeNote({ ...result, verdict: 'fraud' }, c, opts),
      },
    };
    this.cache.set(sid, out);
    this.cases.set(sid, c);
    return this.view(sid);
  }
}

// The player's journals (Terra calls them devlogs) oldest first, and the commit history newest first.
// Terra tags each commit with the journal it belongs to (devlogId); a commit whose journal isn't on
// this ship (or has none) counts as untagged.
function journalsAndCommits(d) {
  const time = (x) => Date.parse(x) || 0;
  const journals = (d.devlogs || [])
    .map((j) => ({
      id: j.id, title: j.title || '', body: j.body || '', createdAt: j.createdAt || null,
      creditedSeconds: j.creditedSeconds || 0, hackatimeSeconds: j.hackatimeSeconds || 0,
      images: (j.images || []).map((i) => i && i.url).filter(Boolean),
    }))
    .sort((a, b) => time(a.createdAt) - time(b.createdAt));
  const ids = new Set(journals.map((j) => j.id));
  const commits = (((d.evidence || {}).data || {}).commits || [])
    .filter((c) => c && typeof c.sha === 'string')
    .map((c) => ({
      sha: c.sha, message: c.message || '', committedAt: c.committedAt || null,
      author: c.authorLogin || c.authorName || null, additions: c.additions || 0, deletions: c.deletions || 0,
      journalId: ids.has(c.devlogId) ? c.devlogId : null,
    }))
    .sort((a, b) => time(b.committedAt) - time(a.committedAt));
  return { journals, commits };
}

// ---------- re-ships ----------
// Reviewers write change requests in their own words, so match the note to topics Blanche can check
// and report each one against today's findings, plus everything the player did since the request.
const TOPICS = [
  { key: 'readme', label: 'README', re: /read\s?me/i, ids: ['readme-missing', 'readme-short', 'readme-template', 'readme-no-howto', 'readme-no-images'] },
  { key: 'screenshot', label: 'Screenshots', re: /screen\s?shots?|pictures?|images?|\bgifs?\b|photos?/i, ids: ['readme-no-images', 'screenshot-missing', 'screenshot-format'] },
  { key: 'howto', label: 'How to run', re: /how to (run|install|play|use|build)|instructions|install/i, ids: ['readme-no-howto'] },
  { key: 'demo', label: 'Demo link', re: /demo|playable|\blink\b|\burl\b|crash|can'?t (open|run|play|get)|doesn'?t (work|run|load|open)|blank/i, ids: ['demo-'] },
  { key: 'release', label: 'Release build', re: /release|\bbuilds?\b|\.exe|executable|binar(y|ies)|download|appimage|\.dmg|\.apk/i, ids: ['release-missing', 'release-source-only', 'no-build'] },
  { key: 'repo', label: 'Code on GitHub', re: /github|\brepo\b|commit|push|source code|missing .*file|\.(py|js|ts|cs|cpp|gd|java|rs|go)\b/i, ids: ['repo-missing', 'repo-none', 'repo-private', 'single-commit', 'tiny-repo'] },
  { key: 'ai', label: 'AI use', re: /\bai\b|ai[- ]generated|chatgpt|copilot|\bllm\b|claude|gemini/i, ids: ['ai-undeclared'], manual: true },
];
const DECISION_LABEL = { changes: 'Changes requested', approved: 'Approved', rejected: 'Rejected', send_fraud: 'Sent to fraud', send_admin: 'Sent to an admin', release_admin: 'Back from an admin', release_fraud: 'Back from fraud' };

function reshipCheck(d, findings, repo, demoCheck, { journals, commits }) {
  const decisions = (d.decisions || [])
    .filter((x) => x && x.createdAt)
    .map((x) => ({ decision: x.decision, label: DECISION_LABEL[x.decision] || x.decision, at: x.createdAt,
      reviewer: (x.reviewer && (x.reviewer.username || x.reviewer.displayName)) || x.reviewer || null, note: x.noteToMaker || '' }));
  const last = decisions.find((x) => x.decision === 'changes');
  if (!last) return null;
  const since = Date.parse(last.at);
  const newCommits = commits.filter((c) => Date.parse(c.committedAt) > since);
  const newJournals = journals.filter((j) => Date.parse(j.createdAt) > since);
  const has = (ids) => findings.filter((f) => ids.some((id) => (id.endsWith('-') ? f.id.startsWith(id) : f.id === id)));
  const rs = repo && repo.readmeStats;
  const now = {
    readme: rs ? `${rs.words} words, ${rs.images} image${rs.images === 1 ? '' : 's'}${rs.instructions ? ', has how-to' : ''}` : rs === null ? 'no README' : null,
    screenshot: rs ? `${rs.images} image${rs.images === 1 ? '' : 's'} in the README` : null,
    howto: rs ? (rs.instructions ? 'README has run/install steps' : null) : null,
    demo: demoCheck ? `demo answers ${demoCheck.status}${demoCheck.ms != null ? ` in ${(demoCheck.ms / 1000).toFixed(1)}s` : ''}` : null,
    release: repo && repo.releases ? (repo.releases[0] ? `latest release ${repo.releases[0].tag}: ${repo.releases[0].assets.length ? repo.releases[0].assets.join(', ') : 'source only'}` : 'no releases') : null,
    repo: `${newCommits.length} commit${newCommits.length === 1 ? '' : 's'} since the request`,
  };
  const topics = TOPICS.filter((t) => t.re.test(last.note)).map((t) => {
    const still = has(t.ids);
    // "ok" only when Blanche actually saw the thing (a README it read, releases it listed, a demo it opened)
    let status = still.length ? 'flagged' : t.manual || now[t.key] == null ? 'check' : 'ok';
    if (t.key === 'repo' && !still.length && !newCommits.length) status = 'check';
    const unknown = { readme: "couldn't read the README", screenshot: "couldn't read the README", howto: 'no run/install steps found',
      demo: "the demo wasn't opened", release: "couldn't list the releases" }[t.key];
    return { key: t.key, label: t.label, status, findings: still.map((f) => f.id), titles: still.map((f) => f.title), now: now[t.key] || (still.length ? null : unknown || null) };
  });
  return { last, earlier: decisions.filter((x) => x !== last), topics, newCommits: newCommits.length, newJournals: newJournals.map((j) => j.id),
    noCommitsSince: newCommits.length === 0 };
}

function approveNote(c, opts) {
  const handle = (opts.handle || '').trim();
  return `Nice work on ${c.title ? `"${c.title}"` : 'this'}! Approved.${handle ? `\n\nIf you have any questions DM ${handle}` : ''}`;
}

function summarizeRepo(r) {
  if (!r) return null;
  const { readme, ...rest } = r;
  const { analyzeReadme } = require('./rules');
  return { ...rest, readmeStats: readme == null ? readme : analyzeReadme(readme), readmeExcerpt: readme ? readme.slice(0, 4000) : null };
}

module.exports = { Analyzer, buildCase, shipProblems, decisionSteps, journalsAndCommits, approveNeeds, approveProblems, reshipCheck, BLOCKING };
