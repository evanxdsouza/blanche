// Repo facts for the rules: does it exist, README text, releases and their files, size, fork.
// Uses the GitHub REST API (a token raises the limit from 60 to 5000 requests an hour).
// Without a token, or once rate limited, it still gets the README from raw.githubusercontent.com.
const UA = 'Blanche-review-dashboard';

function parseRepo(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  if (!/^(www\.)?github\.com$/i.test(u.hostname)) return { host: u.hostname.toLowerCase() };
  const [owner, name] = u.pathname.split('/').filter(Boolean);
  if (!owner || !name) return null;
  return { host: 'github.com', owner, name: name.replace(/\.git$/, '') };
}

class GitHub {
  constructor(token) {
    this.token = token || '';
    this.limitedUntil = 0;
  }

  async api(path, accept = 'application/vnd.github+json') {
    if (Date.now() < this.limitedUntil) return { status: 'limited' };
    const headers = { 'User-Agent': UA, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const r = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(15000) });
    if ((r.status === 403 || r.status === 429) && r.headers.get('x-ratelimit-remaining') === '0') {
      this.limitedUntil = Number(r.headers.get('x-ratelimit-reset') || 0) * 1000 || Date.now() + 60e3;
      return { status: 'limited' };
    }
    if (r.status === 404) return { status: 404 };
    if (!r.ok) return { status: r.status };
    return { status: 200, body: accept.includes('raw') ? await r.text() : await r.json(), headers: r.headers };
  }

  async rawReadme(owner, name) {
    for (const f of ['README.md', 'readme.md', 'Readme.md', 'README.MD', 'README', 'README.rst', 'README.txt']) {
      const r = await fetch(`https://raw.githubusercontent.com/${owner}/${name}/HEAD/${f}`, {
        headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000),
      }).catch(() => null);
      if (r && r.ok) return await r.text();
    }
    return null;
  }

  // A short diff for one commit: a few files, each patch cut to a few lines, so it reads at a glance.
  // -> { status: 'ok', sha, files: [{ filename, status, additions, deletions, patch, cut }], moreFiles } | { status, error }
  async commit(codeUrl, sha, { maxFiles = 12, maxLines = 24 } = {}) {
    const ref = parseRepo(codeUrl);
    if (!ref || ref.host !== 'github.com') return { status: 'error', error: 'Diffs only work for GitHub repos.' };
    const r = await this.api(`/repos/${ref.owner}/${ref.name}/commits/${sha}`);
    if (r.status === 'limited') return { status: 'limited', error: 'GitHub rate limit (add a GitHub token in Settings)' };
    if (r.status === 404 || r.status === 422) return { status: 'missing', error: "GitHub doesn't have this commit (force-pushed away, or the repo is private)." };
    if (r.status !== 200) return { status: 'error', error: `GitHub ${r.status}` };
    return shortDiff(r.body, { maxFiles, maxLines });
  }

  // -> { status: 'ok'|'missing'|'error'|'other-host', owner, readme, releases, codeBytes, fork, parent, ... }
  async repo(codeUrl) {
    const ref = parseRepo(codeUrl);
    if (!ref) return { status: 'error', error: 'not a repo URL' };
    if (ref.host !== 'github.com') return { status: 'other-host', host: ref.host };
    const { owner, name } = ref;
    const base = `/repos/${owner}/${name}`;
    try {
      const info = await this.api(base);
      if (info.status === 404) return { status: 'missing', owner, name };
      if (info.status !== 200) {
        // rate limited or GitHub trouble: the README still works through raw
        const readme = await this.rawReadme(owner, name);
        return { status: readme != null ? 'ok' : 'error', partial: true, owner, name, readme: readme ?? undefined,
          error: info.status === 'limited' ? 'GitHub rate limit (add a GitHub token in Settings)' : `GitHub ${info.status}` };
      }
      const b = info.body;
      const [readme, releases, langs] = await Promise.all([
        this.api(`${base}/readme`, 'application/vnd.github.raw'),
        this.api(`${base}/releases?per_page=10`),
        this.api(`${base}/languages`),
      ]);
      return {
        status: 'ok', owner: b.owner?.login || owner, name: b.name, fullName: b.full_name,
        fork: !!b.fork, parent: b.parent?.full_name || null, private: !!b.private, archived: !!b.archived,
        license: b.license?.spdx_id || null, createdAt: b.created_at, pushedAt: b.pushed_at,
        defaultBranch: b.default_branch,
        readme: readme.status === 200 ? readme.body : readme.status === 404 ? null : await this.rawReadme(owner, name),
        releases: releases.status === 200
          ? releases.body.map((r) => ({ tag: r.tag_name, name: r.name, draft: r.draft, assets: (r.assets || []).map((a) => a.name), url: r.html_url }))
          : null,
        codeBytes: langs.status === 200 ? Object.values(langs.body).reduce((n, x) => n + x, 0) : null,
        languages: langs.status === 200 ? langs.body : null,
      };
    } catch (e) {
      return { status: 'error', owner, name, error: e.message };
    }
  }
}

// GitHub's commit body -> the short form above. Biggest files first; binary files have no patch.
function shortDiff(body, { maxFiles = 12, maxLines = 24 } = {}) {
  const all = (body.files || []).slice().sort((a, b) => (b.changes || 0) - (a.changes || 0));
  const files = all.slice(0, maxFiles).map((f) => {
    const lines = f.patch == null ? null : f.patch.split('\n');
    return {
      filename: f.filename, previous: f.previous_filename || null, status: f.status,
      additions: f.additions || 0, deletions: f.deletions || 0,
      patch: lines ? lines.slice(0, maxLines).join('\n') : null,
      cut: lines ? Math.max(0, lines.length - maxLines) : 0,
    };
  });
  return {
    status: 'ok', sha: body.sha, url: body.html_url || null,
    stats: body.stats || null, files, moreFiles: Math.max(0, all.length - files.length),
  };
}

module.exports = { GitHub, parseRepo, shortDiff };
