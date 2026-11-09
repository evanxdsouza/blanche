// Gathers everything about one ship (Terra + GitHub + the live demo link), runs the rules,
// and builds the requests for a decision.
const { evaluate, composeNote, classifyDemo } = require('./rules');

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

function decisionSteps(d, verdict, { note, internalNote }) {
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
  throw new Error(`unknown verdict ${verdict}`);
}

class Analyzer {
  constructor({ terra, github, checkDemo, settings }) {
    this.terra = terra;
    this.github = github;
    this.checkDemo = checkDemo;
    this.settings = settings;
    this.cache = new Map(); // sid -> result
  }

  async analyze(sid, { fresh = false } = {}) {
    if (!fresh && this.cache.has(sid)) return this.cache.get(sid);
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
      problems: { changes: shipProblems(d, 'changes'), reject: shipProblems(d, 'reject'), fraud: shipProblems(d, 'fraud') },
      ...result,
      notes: {
        changes: composeNote({ ...result, verdict: 'changes' }, c, opts),
        reject: composeNote({ ...result, verdict: 'reject' }, c, opts),
        fraud: composeNote({ ...result, verdict: 'fraud' }, c, opts),
      },
    };
    this.cache.set(sid, out);
    return out;
  }
}

function summarizeRepo(r) {
  if (!r) return null;
  const { readme, ...rest } = r;
  const { analyzeReadme } = require('./rules');
  return { ...rest, readmeStats: readme == null ? readme : analyzeReadme(readme), readmeExcerpt: readme ? readme.slice(0, 4000) : null };
}

module.exports = { Analyzer, buildCase, shipProblems, decisionSteps };
