// Blanche's rule engine. Pure functions only: everything it looks at is passed in as a "case"
// (see buildCase in analyze.js), so it can be tested without any network.
//
// Each rule returns findings shaped like
//   { id, verdict, confidence, title, detail, note, guideline }
// verdict:    'reject' | 'fraud' | 'changes' | 'warn'
// confidence: 'high' (safe to act on after a glance) | 'medium' (check it) | 'low' (a hint)
// note:       the sentence the player reads if the reviewer sends it (changes/reject only)
const G = require('./guidelines');

const DEFAULTS = {
  readmeMinWords: 80,        // under this the README is "too short"
  readmeTinyWords: 30,       // under this it's too short with high confidence
  requireReadmeImage: true,  // no screenshot/photo in the README -> changes
  singleCommitHours: 3,      // one commit is fine for a tiny ship, not for this many hours
  burstCommitHours: 8,       // all commits inside one hour while claiming this many hours
  tinyRepoBytes: 3000,       // code smaller than this...
  tinyRepoHours: 6,          // ...for at least this many hours
  aiShare: 0.5,              // AI time share that needs an AI declaration
  longSessionHours: 6,       // one session without a break this long
  outOfRepoShare: 0.4,       // share of time on files that never reached the repo
  handle: '',                // reviewer handle for the sign-off, e.g. @blanche
};

// ---------- demo / playable URL ----------

const BINARY_EXT = /\.(exe|msi|msix|appx|dmg|pkg|deb|rpm|appimage|x86_64|apk|aab|ipa|jar|crx|xpi|vsix|zip|7z|tar\.gz|tgz|tar\.xz|love|wasm|nes|gba|gb|uf2|hex|bin|mrpack)$/i;

const STORES = [
  /(^|\.)itch\.io$/, /(^|\.)pypi\.org$/, /(^|\.)npmjs\.(com|org)$/, /(^|\.)crates\.io$/,
  /^chromewebstore\.google\.com$/, /^chrome\.google\.com$/, /^addons\.mozilla\.org$/,
  /(^|\.)modrinth\.com$/, /(^|\.)curseforge\.com$/, /^play\.google\.com$/, /^apps\.apple\.com$/,
  /^testflight\.apple\.com$/, /^marketplace\.visualstudio\.com$/, /^open-vsx\.org$/,
  /^steamcommunity\.com$/, /^store\.steampowered\.com$/, /(^|\.)flathub\.org$/, /^snapcraft\.io$/,
  /^formulae\.brew\.sh$/, /^apps\.microsoft\.com$/, /^www\.microsoft\.com$/, /^sprig\.hackclub\.com$/,
  /^discord\.com$/, /^discord\.gg$/, /(^|\.)slack\.com$/, /^pkg\.go\.dev$/, /^rubygems\.org$/,
  /^packagist\.org$/, /^hub\.docker\.com$/, /^ghcr\.io$/, /^www\.nuget\.org$/, /^pub\.dev$/, /^hex\.pm$/, /^jsr\.io$/, /^www\.roblox\.com$/,
];

const isPrivateHost = (h) =>
  h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '0.0.0.0' || h === '[::1]' ||
  /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);

// What kind of link the player gave as their demo, from the URL alone.
function classifyDemo(raw) {
  const s = (raw || '').trim();
  if (!s) return { kind: 'none' };
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return { kind: 'invalid' };
  }
  if (!/^https?:$/.test(u.protocol)) return { kind: 'invalid', url: u.href };
  const h = u.hostname.toLowerCase();
  const p = u.pathname.replace(/\/+$/, '');
  const out = (kind, extra) => ({ kind, url: u.href, host: h, ...extra });

  if (isPrivateHost(h)) return out('local');
  if (/(^|\.)(ngrok-free\.app|ngrok\.app|ngrok\.io|ngrok-free\.dev|trycloudflare\.com|loca\.lt|localtunnel\.me|serveo\.net|localhost\.run|pinggy\.link|devtunnels\.ms|app\.github\.dev|csb\.app|repl\.co|replit\.dev|gitpod\.io|webcontainer\.io|stackblitz\.io)$/.test(h))
    return out('ephemeral');
  if (/(^|\.)streamlit\.app$/.test(h) || h === 'share.streamlit.io') return out('streamlit');
  if (/(^|\.)onrender\.com$/.test(h)) return out('render');
  if (h === 'colab.research.google.com' || /(^|\.)mybinder\.org$/.test(h) || /\.ipynb$/i.test(p) ||
      (/(^|\.)kaggle\.com$/.test(h) && /^\/code\//.test(p)) || /(^|\.)deepnote\.com$/.test(h))
    return out('notebook');
  if (h === 'drive.google.com' || h === 'docs.google.com') return out('gdrive');
  if (/(^|\.)(leetcode\.com|leetcode\.cn|hackerrank\.com|codeforces\.com|codewars\.com|codechef\.com|atcoder\.jp)$/.test(h))
    return out('leetcode');
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com|loom\.com)$/.test(h)) return out('video');

  if (h === 'github.com' || h === 'www.github.com' || h === 'gitlab.com' || h === 'codeberg.org' || h === 'bitbucket.org') {
    const parts = p.split('/').filter(Boolean);
    const repo = parts.length >= 2 ? { owner: parts[0], name: parts[1].replace(/\.git$/, '') } : null;
    if (parts[2] === 'releases') {
      if (parts[3] === 'download' || BINARY_EXT.test(p)) return out('binary', { repo });
      const tag = parts[3] === 'tag' ? decodeURIComponent(parts.slice(4).join('/')) : parts[3] === 'latest' ? 'latest' : null;
      return out('release', { repo, tag });
    }
    if (BINARY_EXT.test(p) && (parts[2] === 'raw' || parts[2] === 'blob')) return out('binary', { repo });
    return out('source', { repo });
  }
  if (h === 'raw.githubusercontent.com' || h === 'objects.githubusercontent.com') {
    return BINARY_EXT.test(p) ? out('binary') : out('source');
  }
  if (BINARY_EXT.test(p)) return out('binary');
  if (STORES.some((r) => r.test(h))) return out('store');
  return out('web');
}

// ---------- README ----------

const TEMPLATE_READMES = [
  /getting started with create react app/i,
  /this template provides a minimal setup to get react working in vite/i,
  /this template should help get you started developing with vue 3 in vite/i,
  /this is a \[next\.js\]\(https:\/\/nextjs\.org\) project bootstrapped with/i,
  /everything you need to build a svelte project, powered by/i,
  /this project was generated (with|using) \[angular cli\]/i,
  /welcome to your new tauri app/i,
  /a new flutter project\.?\s*(## getting started)?/i,
];

const INSTRUCTION_WORDS = /\b(install|installation|run|running|usage|use it|how to (use|play|run|install)|getting started|setup|set up|download|play|controls|build|launch|open|visit|demo|try it)\b/i;

function analyzeReadme(text) {
  if (text == null) return null;
  const raw = String(text);
  const images = [
    ...raw.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g),
    ...raw.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi),
    ...raw.matchAll(/^\s*\[[^\]]+\]:\s*(\S+\.(?:png|jpe?g|gif|webp|svg|avif))/gim),
    ...raw.matchAll(/(?:^|\s)(https:\/\/github\.com\/user-attachments\/assets\/[\w-]+)/g),
  ].map((m) => m[1]);
  // badges (shields.io etc.) are images but don't show the project
  const shots = images.filter((u) => !/shields\.io|badge|badgen\.net|travis-ci|circleci|codecov|github\.com\/[^/]+\/[^/]+\/(actions\/)?workflows/i.test(u));
  const prose = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#>*_`|~-]+/g, ' ');
  const words = (prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu) || []).length;
  return {
    chars: raw.length,
    words,
    images: shots.length,
    badges: images.length - shots.length,
    template: TEMPLATE_READMES.some((r) => r.test(raw.trim())) && words < 250,
    instructions: INSTRUCTION_WORDS.test(prose),
  };
}

// ---------- the rules ----------

const SCHOOL = /\b(school (assignment|project|homework)|class (assignment|project)|homework|coursework|course ?work|assigned (to us |to me )?by (my|our) (teacher|professor|instructor)|for my (cs|computer science|programming|coding|ap csp?|ict|it|comp ?sci)\s+class|(cs|computer science) (class|course) (project|assignment)|final project for (my|our|the) (class|course)|uni(versity)? assignment|lab assignment)\b/i;
const HACKATHON = /\b(made|built|created|submitted|winner|won|developed) (for|at|during) (the )?[\w .'-]{0,40}hackathon\b|\b(devpost|mlh|major league hacking)\b/i;
const TUTORIAL = /\b(follow(ed|ing)? (a|the|this) (youtube |video )?tutorial|from (a|the) tutorial|tutorial by|based on (a|the|this) (youtube |video )?tutorial|course by|code ?along)\b/i;

const hrs = (s) => `${((s || 0) / 3600).toFixed(1)}h`;

function evaluate(c, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const F = [];
  const add = (f) => F.push(f);
  const hoursClaimed = (c.seconds || 0) / 3600;
  const plats = (c.platforms || []).map((x) => String(x).toLowerCase());
  const desktop = plats.filter((x) => ['windows', 'linux', 'macos'].includes(x));
  const demo = classifyDemo(c.demoUrl);
  const check = c.demoCheck || {}; // live result: { status, ok, error, finalUrl }
  const repo = c.repo || {};
  const releases = repo.releases || null; // null = unknown
  const binaryReleases = releases ? releases.filter((r) => (r.assets || []).some((a) => BINARY_EXT.test(a))) : null;
  const readme = repo.readme === undefined ? undefined : analyzeReadme(repo.readme);

  // --- playable URL ---
  const demoNote = {
    none: 'There\'s no demo link. Add a link where anyone can try the project: a hosted website, a GitHub release with a build (.exe, .AppImage, .dmg, ...), a package on PyPI/npm/crates.io, or a store page.',
    invalid: 'The demo link isn\'t a valid URL. Add a link where anyone can try the project.',
    local: 'The demo link points at localhost / a private address, so nobody else can open it. Host it publicly (GitHub Pages, Vercel, Netlify, Railway, Nest...).',
    ephemeral: 'The demo link is a temporary tunnel / dev-environment URL that will stop working. Host it somewhere permanent (GitHub Pages, Vercel, Netlify, Railway, Nest...).',
    streamlit: 'Streamlit isn\'t an allowed host for demos. Please host it on Nest, Railway or Vercel instead.',
    render: 'Render isn\'t an allowed host anymore (it takes too long to spin up). Please host it on Nest, Railway or Vercel instead.',
    notebook: 'A Colab/Jupyter notebook isn\'t a playable demo, it\'s a development tool. Turn it into something people can run without setup (a hosted web app, a package, or a release build).',
    gdrive: 'Google Drive isn\'t an allowed host for demos. Use a GitHub release for builds, or YouTube/Vimeo for a video demo.',
    source: 'The demo link goes to the source code. The demo needs to be something people can try without building it themselves: a hosted website, a GitHub release with a build, a package on a package registry, or a store page.',
  };
  if (demoNote[demo.kind]) {
    add({
      id: `demo-${demo.kind}`, verdict: 'changes', confidence: 'high',
      title: { none: 'No demo link', invalid: 'Demo link is not a URL', local: 'Demo is on localhost', ephemeral: 'Demo is a temporary URL', streamlit: 'Demo hosted on Streamlit (disallowed)', render: 'Demo hosted on Render (disallowed)', notebook: 'Demo is a notebook', gdrive: 'Demo on Google Drive (disallowed)', source: 'Demo link is just the source code' }[demo.kind],
      detail: demo.url || '',
      note: demoNote[demo.kind],
      guideline: ['streamlit', 'render', 'gdrive'].includes(demo.kind) ? G.disallowedHosts : G.playableUrl,
    });
  }
  if (demo.kind === 'leetcode') {
    add({
      id: 'leetcode', verdict: 'reject', confidence: 'medium', title: 'Competitive-programming solution',
      detail: demo.url, guideline: G.playableUrl,
      note: 'LeetCode / competitive-programming solutions can\'t be accepted as projects.',
    });
  }
  if (demo.kind === 'release' && releases) {
    const rel = demo.tag && demo.tag !== 'latest' ? releases.find((r) => r.tag === demo.tag) : releases[0];
    if (!releases.length) {
      add({
        id: 'release-missing', verdict: 'changes', confidence: 'high', title: 'Demo is a releases page with no releases',
        detail: demo.url, guideline: G.playableUrl,
        note: 'The demo link goes to a releases page, but there are no releases yet. Publish a release with a build people can download and run.',
      });
    } else if (rel && !(rel.assets || []).some((a) => BINARY_EXT.test(a))) {
      add({
        id: 'release-source-only', verdict: 'changes', confidence: 'high', title: 'Release has only source code',
        detail: `${rel.tag}: ${(rel.assets || []).join(', ') || 'no files'}`, guideline: G.playableUrl,
        note: 'The release only has the source code zip. Attach a build people can run without compiling it (.exe, .AppImage, .dmg, .apk, ...).',
      });
    }
  }
  if (check.status && ['web', 'release', 'binary', 'store', 'video'].includes(demo.kind) && !(demo.kind === 'release' && releases)) {
    if (check.broken) {
      add({
        id: 'demo-broken', verdict: 'changes', confidence: check.confident ? 'high' : 'medium',
        title: `Demo link is broken (${check.status})`, detail: `${demo.url}${check.error ? ` · ${check.error}` : ''}`,
        guideline: G.playableUrl,
        note: 'The demo link doesn\'t work (I get an error when I open it). Fix it or swap it for a working one.',
      });
    } else if (check.ms >= 30000) {
      add({
        id: 'demo-slow', verdict: 'changes', confidence: 'medium', title: `Demo took ${Math.round(check.ms / 1000)}s to load`,
        detail: demo.url, guideline: G.disallowedHosts,
        note: 'The demo takes more than 30 seconds to load, which counts as a disallowed host. Move it somewhere that doesn\'t need to spin up (Nest, Railway, Vercel...).',
      });
    } else if (check.gated) {
      add({
        id: 'demo-login', verdict: 'changes', confidence: 'medium', title: 'Demo looks like it needs a login',
        detail: check.finalUrl || demo.url, guideline: G.websites,
        note: 'The demo goes straight to a login page. If an account is needed, add demo login details to the ship notes or README.',
      });
    }
  }
  if (demo.kind === 'video' && !plats.includes('other')) {
    add({
      id: 'demo-video', verdict: 'changes', confidence: 'high', title: 'Demo is only a video',
      detail: demo.url, guideline: G.playableUrl,
      note: 'Video demos aren\'t allowed as the demo link for software (videos are only for hardware). Link something people can actually try: a hosted site, a release build, a package or a store page.',
    });
  }
  const runnable = ['binary', 'store'].includes(demo.kind) || (demo.kind === 'release' && binaryReleases && binaryReleases.length) || (binaryReleases && binaryReleases.length);
  if (desktop.length && !plats.includes('web') && ['web'].includes(demo.kind) === false && !runnable && releases) {
    add({
      id: 'no-build', verdict: 'changes', confidence: 'medium', title: `Says it runs on ${desktop.join('/')} but there's no build`,
      detail: `${releases.length} release(s), none with a binary`, guideline: G.desktop,
      note: `The ship says it runs on ${desktop.map((x) => ({ windows: 'Windows', linux: 'Linux', macos: 'macOS' })[x]).join(' / ')}, but there's no build to download. Publish a GitHub release with an installer or executable (.exe, .msi, .AppImage, .deb, .dmg...) and link it as the demo.`,
    });
  }

  // --- code URL / repo ---
  if (!c.codeUrl) {
    add({ id: 'repo-none', verdict: 'changes', confidence: 'high', title: 'No repo link', guideline: G.codeUrl,
      note: 'There\'s no link to the source code. Add a link to a public repository.' });
  } else if (repo.status === 'missing') {
    add({ id: 'repo-missing', verdict: 'changes', confidence: 'high', title: 'Repo is private or doesn\'t exist', detail: c.codeUrl,
      guideline: G.codeUrl, note: 'The repository link gives a 404, so it\'s either private or gone. Make the repo public (or fix the link).' });
  } else if (repo.private) {
    add({ id: 'repo-private', verdict: 'changes', confidence: 'high', title: 'Repo is private', detail: c.codeUrl,
      guideline: G.codeUrl, note: 'The repository is private. Make it public so anyone can see the code.' });
  }

  // --- README ---
  if (repo.status === 'ok' && readme === null) {
    add({ id: 'readme-missing', verdict: 'changes', confidence: 'high', title: 'No README', guideline: G.codeUrl,
      note: 'The repo has no README. Add one that explains what the project is, how to set it up, and how to run or play it.' });
  } else if (readme) {
    if (readme.template) {
      add({ id: 'readme-template', verdict: 'changes', confidence: 'high', title: 'README is the framework template',
        detail: `${readme.words} words`, guideline: G.reproducibility,
        note: 'The README is still the default template from the framework. Replace it with your own: what the project is, how to use it, and how to run it.' });
    } else if (readme.words < o.readmeMinWords) {
      add({ id: 'readme-short', verdict: 'changes', confidence: readme.words < o.readmeTinyWords ? 'high' : 'medium',
        title: `README is too short (${readme.words} words)`, detail: `minimum is ${o.readmeMinWords}`, guideline: G.codeUrl,
        note: 'The README is too short. Expand it to explain what the project is, what it does, how to set it up, and how to run or play it.' });
    } else if (!readme.instructions) {
      add({ id: 'readme-no-howto', verdict: 'changes', confidence: 'medium', title: 'README has no setup / usage instructions',
        guideline: G.reproducibility,
        note: 'The README doesn\'t say how to run or use the project. Add setup / usage instructions so anyone can try it.' });
    }
    if (o.requireReadmeImage && readme.images === 0 && !readme.template) {
      add({ id: 'readme-no-images', verdict: 'changes', confidence: 'high', title: 'No screenshots in the README',
        detail: readme.badges ? `${readme.badges} badge(s) only` : '', guideline: G.screenshot,
        note: 'The README has no screenshots or photos. Add at least one image showing the project in action.' });
    }
    if (TUTORIAL.test(repo.readme)) {
      add({ id: 'tutorial', verdict: 'warn', confidence: 'medium', title: 'README mentions following a tutorial',
        detail: (repo.readme.match(TUTORIAL) || [''])[0], guideline: G.spotChecks,
        note: '' });
    }
  }

  // --- ship fields ---
  if (!c.screenshotUrl) {
    add({ id: 'screenshot-missing', verdict: 'changes', confidence: 'high', title: 'No screenshot', guideline: G.screenshot,
      note: 'The ship has no screenshot. Add an image of the project running.' });
  } else if (/\.(gif|mp4|webm|mov)(\?|$)/i.test(c.screenshotUrl)) {
    add({ id: 'screenshot-format', verdict: 'changes', confidence: 'high', title: 'Screenshot is animated / a video', detail: c.screenshotUrl,
      guideline: G.screenshot, note: 'The screenshot has to be a still image (no GIFs or videos). Swap it for a PNG or JPG.' });
  }
  if (!(c.description || '').trim()) {
    add({ id: 'description-missing', verdict: 'changes', confidence: 'high', title: 'No description', guideline: G.description,
      note: 'The project has no description. Add a short summary of what it is and what it does.' });
  }

  // --- exceptions -> reject ---
  const text = [c.description, c.shipNotes, repo.readme].filter(Boolean).join('\n');
  const school = text.match(SCHOOL);
  if (school) {
    add({ id: 'school', verdict: 'reject', confidence: 'medium', title: 'Looks like a school assignment',
      detail: `"${school[0]}"`, guideline: G.school,
      note: 'Projects made for a school assignment can\'t be accepted, so I can\'t approve this one.' });
  }

  const hack = text.match(HACKATHON);
  if (hack) {
    add({ id: 'hackathon', verdict: 'warn', confidence: 'medium', title: 'Mentions an outside hackathon',
      detail: `"${hack[0]}": only time after the hackathon counts (unless it was registered in Terra first)`, guideline: G.hackathons, note: '' });
  }

  // --- commits ---
  const commits = c.commits || [];
  const commitCount = commits.length || repo.commitCount || 0;
  if ((commits.length || repo.commitCount != null) && commitCount <= 1 && hoursClaimed >= o.singleCommitHours) {
    add({ id: 'single-commit', verdict: 'changes', confidence: 'high', title: `${commitCount} commit for ${hrs(c.seconds)}`,
      guideline: G.codeUrl,
      note: 'The repo has only one commit for the hours logged. Commit as you go so the history shows how the project was built.' });
  }
  if (commits.length >= 2 && hoursClaimed >= o.burstCommitHours) {
    const t = commits.map((x) => Date.parse(x.committedAt)).filter(Number.isFinite).sort((a, b) => a - b);
    const span = t.length >= 2 ? (t[t.length - 1] - t[0]) / 3600e3 : null;
    if (span != null && span < 1) {
      add({ id: 'commit-burst', verdict: 'fraud', confidence: 'medium', title: `All ${commits.length} commits within ${Math.round(span * 60)} min`,
        detail: `${hrs(c.seconds)} claimed`, guideline: G.fraud, note: '' });
    }
  }

  // --- fraud signals ---
  const danger = (c.flags || []).filter((f) => f.severity === 'danger' && !f.dismissedAt);
  if (danger.length) {
    add({ id: 'danger-flags', verdict: 'fraud', confidence: 'high', title: `${danger.length} danger flag(s) from Terra`,
      detail: danger.map((f) => f.title || f.kind).join('; '), guideline: G.fraud, note: '' });
  }
  if ((c.unifiedUrlMatches || []).length && !c.isUpdate) {
    add({ id: 'double-dip', verdict: 'fraud', confidence: 'high', title: 'Same repo submitted to another YSWS program',
      detail: `${c.unifiedUrlMatches.length} match(es), not marked as an update`, guideline: G.duplicates, note: '' });
  }
  if (repo.fork) {
    add({ id: 'fork', verdict: 'fraud', confidence: 'medium', title: 'Repo is a fork', detail: repo.parent || '',
      guideline: G.fraud, note: '' });
  }
  if (repo.codeBytes != null && repo.codeBytes < o.tinyRepoBytes && hoursClaimed >= o.tinyRepoHours) {
    add({ id: 'tiny-repo', verdict: 'fraud', confidence: 'medium', title: `${(repo.codeBytes / 1024).toFixed(1)} KB of code for ${hrs(c.seconds)}`,
      guideline: G.inflated, note: '' });
  }
  const total = c.time?.totalSeconds || c.seconds || 0;
  const ai = c.time?.aiSeconds || 0;
  if (total && ai / total >= o.aiShare && !/\w{3,}/.test((c.aiDeclaration || '').replace(/\b(none|no|n\/a|na)\b/gi, ''))) {
    add({ id: 'ai-undeclared', verdict: 'fraud', confidence: 'medium', title: `${Math.round((ai / total) * 100)}% AI time, no AI declaration`,
      guideline: G.ai, note: '' });
  }
  const longest = Math.max(0, ...(c.sessions || []).map((s) => s.seconds || 0));
  if (longest >= o.longSessionHours * 3600) {
    add({ id: 'long-session', verdict: 'fraud', confidence: 'low', title: `${hrs(longest)} session without a break`,
      guideline: G.fraud, note: '' });
  }
  const files = c.files || [];
  const fileTotal = files.reduce((n, f) => n + (f.seconds || 0), 0);
  const outside = files.filter((f) => f.status !== 'head').reduce((n, f) => n + (f.seconds || 0), 0);
  if (fileTotal && outside / fileTotal >= o.outOfRepoShare && outside >= 2 * 3600) {
    add({ id: 'out-of-repo', verdict: 'fraud', confidence: 'medium', title: `${Math.round((outside / fileTotal) * 100)}% of time on files not in the repo`,
      detail: hrs(outside), guideline: G.inflated, note: '' });
  }

  // --- context, never decides on its own ---
  if (c.githubLogin && repo.owner && repo.owner.toLowerCase() !== c.githubLogin.toLowerCase()) {
    add({ id: 'owner-mismatch', verdict: 'warn', confidence: 'low', title: `Repo owner ${repo.owner} isn't the player (${c.githubLogin})`,
      detail: 'team project or org repo?', guideline: G.duplicates, note: '' });
  }
  if (c.fraudSuggestion) {
    add({ id: 'fraud-reviewed', verdict: 'warn', confidence: 'high', title: `Fraud suggests cutting ${hrs(c.fraudSuggestion.seconds)}`,
      detail: c.fraudSuggestion.reason || '', guideline: G.inflated, note: '' });
  }
  if ((c.changesRounds || 0) >= 3) {
    add({ id: 'changes-limit', verdict: 'warn', confidence: 'high', title: `${c.changesRounds} rounds of changes already`,
      detail: 'Only admins can request changes again: approve or reject.', guideline: G.spotChecks, note: '' });
  }
  if (repo.status === 'error') {
    add({ id: 'repo-error', verdict: 'warn', confidence: 'low', title: 'Couldn\'t read the repo', detail: repo.error || '', guideline: G.codeUrl, note: '' });
  }

  return summarize(F, c);
}

const RANK = { reject: 4, fraud: 3, changes: 2, warn: 1 };
const CONF = { high: 3, medium: 2, low: 1 };

function summarize(findings, c) {
  findings.sort((a, b) => RANK[b.verdict] - RANK[a.verdict] || CONF[b.confidence] - CONF[a.confidence]);
  const has = (v, min = 'low') => findings.some((f) => f.verdict === v && CONF[f.confidence] >= CONF[min]);
  // fraud wins over changes: a ship with fraud signals goes to fraud review, not back to the player
  let verdict = 'clean';
  if (has('reject', 'medium')) verdict = 'reject';
  else if (has('fraud', 'medium')) verdict = 'fraud';
  else if (has('changes')) verdict = 'changes';
  const top = findings.find((f) => f.verdict === verdict);
  // "easy": the deciding finding is high confidence and nothing points the other way
  const easy = verdict === 'changes'
    ? findings.some((f) => f.verdict === 'changes' && f.confidence === 'high') && !has('fraud', 'low') && !has('reject', 'low')
    : verdict === 'fraud' ? findings.some((f) => f.verdict === 'fraud' && f.confidence === 'high')
    : false;
  return { verdict, easy, top: top ? top.title : null, findings };
}

// ---------- notes ----------

function composeNote(result, c, opts = {}) {
  const handle = (opts.handle || '').trim();
  const sign = handle ? `\n\nIf you have any questions DM ${handle}` : '';
  const items = result.findings.filter((f) => f.note && f.verdict === (result.verdict === 'reject' ? 'reject' : 'changes'));
  const name = c.title ? `"${c.title}"` : 'this';
  if (result.verdict === 'reject') {
    return `Hey! Thanks for shipping ${name}. Unfortunately I can't approve it:\n\n${items.map((f) => `- ${f.note}`).join('\n')}\n\n(See the YSWS submission guidelines: ${G.HOME})${sign}`;
  }
  if (result.verdict === 'fraud') {
    return result.findings.filter((f) => f.verdict === 'fraud' || f.id === 'tutorial').map((f) => `- ${f.title}${f.detail ? `: ${f.detail}` : ''}`).join('\n');
  }
  const fixes = result.findings.filter((f) => f.verdict === 'changes' && f.note);
  if (!fixes.length) return '';
  return `Hey! Thanks for shipping ${name}. Before it can be approved, a few things need fixing:\n\n${fixes.map((f) => `- ${f.note}`).join('\n')}\n\nOnce that's done, ship it again and it'll go back in the queue.${sign}`;
}

module.exports = { DEFAULTS, classifyDemo, analyzeReadme, evaluate, composeNote, BINARY_EXT };
