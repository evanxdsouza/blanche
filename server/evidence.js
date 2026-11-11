// Commit evidence, in the spirit of Introspect (introspect.sahil.ink): what kind of commits the repo
// has, how they line up day by day with the coding time Hackatime tracked, and the signals that come
// out of that. Everything comes from Terra's evidence (commits, the hourly heatmap, sessions), so it
// costs no extra requests. Introspect's own thresholds live on its server and aren't public; the ones
// below are Blanche's.

// GitHub's default messages give away how a commit was made.
const WEB_UPLOAD = /^(add|upload) files via upload$/i;
const WEB_EDIT = /^(create|update|delete|rename) [^\s/]+(\/[^\s/]+)*\.[a-z0-9]+$/i; // "Update main.py" from the web editor
const README_ONLY = /^((create|update|delete|edit|revise|fix|improve) )?readme(\.md)?( (file|update|changes?))?$|^(update|edit|revise|improve|fix) (the )?readme\b/i;
const MERGE = /^merge (pull request|branch|remote-tracking branch)\b/i;
const VAGUE = /^(update[sd]?|fix(es|ed)?|commit|changes?|wip|test(ing)?|stuff|idk|asdf+|final|done|minor( (changes|fixes))?|misc|save|progress|work|edits?|new|more|code|\.+|-+|[a-z])$/i;

function kindOf(message) {
  const m = String(message || '').split('\n')[0].trim();
  if (WEB_UPLOAD.test(m)) return 'web-upload';
  if (MERGE.test(m)) return 'merge';
  if (README_ONLY.test(m)) return 'readme';
  if (WEB_EDIT.test(m) || VAGUE.test(m) || m.length <= 3) return 'vague';
  return 'content';
}

// Terra's heatmap and window use the player's local day; its window starts at local midnight, so the
// window's UTC hour gives the offset to put commits on the same days. (Unknown -> UTC.)
function dayOffsetMs(window) {
  const s = window && Date.parse(window.start);
  if (!Number.isFinite(s)) return 0;
  const d = new Date(s);
  if (d.getUTCMinutes() || d.getUTCSeconds()) return 0;
  const h = d.getUTCHours();
  return (h > 12 ? h - 24 : h) * 3600e3; // 05:00Z -> local = UTC-5
}
const dayOf = (iso, off) => new Date(Date.parse(iso) - off).toISOString().slice(0, 10);

function commitEvidence(ev, { claimedSeconds = 0 } = {}) {
  ev = ev || {};
  const commits = (ev.commits || []).filter((c) => c && c.sha);
  const off = dayOffsetMs(ev.window);
  const counts = { total: commits.length, content: 0, readme: 0, 'web-upload': 0, merge: 0, vague: 0 };
  const lines = (c) => (c.additions || 0) + (c.deletions || 0);
  const kinds = commits.map((c) => ({ c, kind: kindOf(c.message) }));
  for (const k of kinds) counts[k.kind]++;
  // code commits: what shows the project being built (vague messages still change code)
  const code = kinds.filter((k) => k.kind === 'content' || k.kind === 'vague').map((k) => k.c);
  const codeLines = code.reduce((n, c) => n + lines(c), 0);
  const largest = code.reduce((a, c) => (lines(c) > lines(a || {}) ? c : a), null);

  // per day: coding seconds from the heatmap (this ship's projects only), commits and lines by local day
  const days = new Map();
  const day = (d) => days.get(d) || days.set(d, { date: d, seconds: 0, commits: 0, lines: 0 }).get(d);
  for (const h of ev.heatmap || []) {
    if (!h || !h.date) continue;
    day(h.date).seconds += (h.ship || []).reduce((n, x) => n + (x || 0), 0);
  }
  for (const c of commits) {
    if (!c.committedAt) continue;
    const d = day(dayOf(c.committedAt, off));
    d.commits++;
    d.lines += lines(c);
  }
  const series = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const tracked = series.reduce((n, d) => n + d.seconds, 0);
  const quietSeconds = series.filter((d) => d.commits === 0).reduce((n, d) => n + d.seconds, 0);
  const busiest = series.reduce((a, d) => (d.lines > (a ? a.lines : -1) ? d : a), null);
  const totalLines = series.reduce((n, d) => n + d.lines, 0);
  const claimedHours = claimedSeconds / 3600;
  const sessions = ev.sessions || [];

  return {
    counts,
    perHour: claimedHours > 0 ? code.length / claimedHours : null,
    largest: largest && codeLines > 0 ? { sha: largest.sha, message: String(largest.message || '').split('\n')[0], lines: lines(largest), share: lines(largest) / codeLines } : null,
    busiest: busiest && totalLines > 0 ? { date: busiest.date, lines: busiest.lines, share: busiest.lines / totalLines } : null,
    trackedSeconds: tracked,
    quietSeconds, // coding time on days with no commit at all
    codingDays: series.filter((d) => d.seconds > 0).length,
    commitDays: series.filter((d) => d.commits > 0).length,
    sessions: { count: sessions.length, longestSeconds: sessions.reduce((n, s) => Math.max(n, s.seconds || 0), 0) },
    truncated: !!ev.commitsTruncated,
    days: series,
    kinds: Object.fromEntries(kinds.map((k) => [k.c.sha, k.kind])),
  };
}

module.exports = { commitEvidence, kindOf, dayOffsetMs };
