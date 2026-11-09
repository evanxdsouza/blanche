// Demo mode (`npm run demo`): a fake Terra, GitHub and demo checker with one ship per rule,
// so the dashboard can be tried and tested without a Terra login. Nothing leaves the machine.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const H = 3600;
const now = Date.now();
const ago = (h) => new Date(now - h * H * 1000).toISOString();
const goodReadme = (title, img = true) => `# ${title}

${title} is a small app I built to learn how the pieces of a real project fit together. It lets you
plan your week, keeps track of what you finished, and shows a summary chart at the end of each week.
I wrote the UI first, then the storage layer, then spent a lot of time on the chart because drawing
it by hand on a canvas turned out to be harder than I thought.
${img ? '\n![screenshot of the app](docs/screenshot.png)\n' : ''}
## How to use it

Download the latest release, unzip it and run the executable. Or open the hosted version in your
browser and click "New week" to start. Everything is saved locally, nothing is sent anywhere.

## Building from source

Install Node 20, run \`npm install\` and then \`npm start\`.
`;

const commits = (n, spanH, startH = 72) => Array.from({ length: n }, (_, i) => ({
  sha: (i + 1).toString(16).padStart(40, 'a'), message: `work ${i + 1}`,
  committedAt: ago(startH - (spanH * i) / Math.max(1, n - 1)), authorLogin: 'player', additions: 40, deletions: 3,
}));

const SHIPS = [
  { n: 1, title: 'Pixel Garden', user: 'maya', hours: 6.2, platforms: ['web'], demo: '', code: 'https://github.com/maya/pixel-garden' },
  { n: 2, title: 'Chess CLI', user: 'oskar', hours: 9.5, platforms: ['linux', 'windows'], demo: 'https://github.com/oskar/chess-cli', code: 'https://github.com/oskar/chess-cli' },
  { n: 3, title: 'Stock Charts', user: 'lena', hours: 4.1, platforms: ['web'], demo: 'https://stock-charts.onrender.com', code: 'https://github.com/lena/stock-charts' },
  { n: 4, title: 'Tiny Platformer', user: 'arjun', hours: 12.3, platforms: ['windows'], demo: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', code: 'https://github.com/arjun/tiny-platformer' },
  { n: 5, title: 'Weather Now', user: 'sofia', hours: 3.4, platforms: ['web'], demo: 'https://weather-now-sofia.vercel.app', code: 'https://github.com/sofia/weather-now' },
  { n: 6, title: 'Habit Hero', user: 'kenji', hours: 7.8, platforms: ['web'], demo: 'https://kenji.github.io/habit-hero', code: 'https://github.com/kenji/habit-hero' },
  { n: 7, title: 'React Todo', user: 'priya', hours: 5.0, platforms: ['web'], demo: 'https://priya-todo.netlify.app', code: 'https://github.com/priya/react-todo' },
  { n: 8, title: 'Grade Calculator', user: 'tom', hours: 4.5, platforms: ['web'], demo: 'https://tom.github.io/grade-calc', code: 'https://github.com/tom/grade-calc' },
  { n: 9, title: 'Snake Deluxe', user: 'zoe', hours: 18.0, platforms: ['windows'], demo: 'https://github.com/zoe/snake-deluxe/releases/latest', code: 'https://github.com/zoe/snake-deluxe' },
  { n: 10, title: 'Synth Pad', user: 'liam', hours: 10.0, platforms: ['web'], demo: 'https://synth-pad.vercel.app', code: 'https://github.com/liam/synth-pad' },
  { n: 11, title: 'Note Vault', user: 'emma', hours: 8.0, platforms: ['windows', 'linux'], demo: 'https://github.com/emma/note-vault/releases/tag/v1.0', code: 'https://github.com/emma/note-vault' },
  { n: 12, title: 'Data Explorer', user: 'noah', hours: 6.0, platforms: ['web'], demo: 'https://data-explorer.streamlit.app', code: 'https://github.com/noah/data-explorer' },
  { n: 13, title: 'Orbit Sim', user: 'ivy', hours: 14.0, platforms: ['web', 'windows'], demo: 'https://orbit-sim.vercel.app', code: 'https://github.com/ivy/orbit-sim' },
];

const REPOS = {
  'maya/pixel-garden': { readme: goodReadme('Pixel Garden') },
  'oskar/chess-cli': { readme: goodReadme('Chess CLI'), releases: [] },
  'lena/stock-charts': { readme: goodReadme('Stock Charts') },
  'arjun/tiny-platformer': { readme: goodReadme('Tiny Platformer'), releases: [{ tag: 'v1', assets: ['tiny-platformer.exe'] }] },
  'sofia/weather-now': { readme: '# Weather Now\n\nShows the weather. Uses an API.\n' },
  'kenji/habit-hero': { readme: goodReadme('Habit Hero', false) },
  'priya/react-todo': { readme: '# Getting Started with Create React App\n\nThis project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).\n\n## Available Scripts\n\nIn the project directory, you can run:\n\n### `npm start`\n' },
  'tom/grade-calc': { readme: goodReadme('Grade Calculator') + '\nThis was my final project for my computer science class this semester.\n' },
  'zoe/snake-deluxe': { readme: goodReadme('Snake Deluxe'), releases: [{ tag: 'v2.0', assets: ['snake-deluxe-win.zip'] }] },
  'liam/synth-pad': { readme: goodReadme('Synth Pad'), codeBytes: 1800 },
  'emma/note-vault': { readme: goodReadme('Note Vault'), releases: [{ tag: 'v1.0', assets: [] }] },
  'noah/data-explorer': { readme: goodReadme('Data Explorer') },
  'ivy/orbit-sim': { readme: goodReadme('Orbit Sim'), releases: [{ tag: 'v1.2', assets: ['orbit-sim-setup.exe', 'orbit-sim.AppImage'] }] },
};

const DEMOS = {
  'https://weather-now-sofia.vercel.app/': { status: 404, ms: 210, broken: true, confident: true },
};

function detail(s) {
  const id = uuid(s.n);
  const extra = {
    9: { flags: [{ kind: 'hackatime_pattern', severity: 'danger', title: 'Heartbeats look scripted' }] },
    10: { unified: [{ program: 'Summer of Making', url: s.code }] },
  }[s.n] || {};
  return {
    shipment: {
      id, projectId: uuid(100 + s.n), title: s.title, weekNumber: 3, platforms: s.platforms, stage: 'review',
      notes: 'Shipped it! Let me know what you think.', aiDeclaration: s.n === 13 ? 'Used Copilot for autocomplete' : '',
      submittedAt: ago(20 + s.n), evidenceVersion: 1, changesRounds: s.n === 6 ? 1 : 0, fraudPending: true,
      hackatimeSeconds: s.hours * H,
    },
    project: {
      title: s.title, description: s.n === 5 ? '' : `${s.title}: a project I built this week.`, codeUrl: s.code, demoUrl: s.demo,
      screenshotUrl: s.n === 8 ? '' : `https://cdn.example/shots/${s.n}.png`, isUpdate: false, hackatimeProjects: [s.title.toLowerCase()],
    },
    maker: { username: s.user, displayName: s.user, githubLogin: s.user, createdAt: ago(800), pastShips: [] },
    viewer: { canReview: true, isOwner: false, isAdmin: false, videoOptional: false },
    claims: { review: null },
    evidence: {
      version: 1, builtAt: ago(19),
      data: {
        time: { creditedSeconds: s.hours * H, totalSeconds: s.hours * H, aiSeconds: s.n === 13 ? s.hours * H * 0.2 : 0 },
        commits: s.n === 2 ? commits(1, 0) : s.n === 9 ? commits(6, 0.5) : commits(8 + s.n, 60),
        files: [{ path: 'src/main.js', seconds: s.hours * H, status: 'head' }],
        sessions: [{ start: ago(30), end: ago(28), seconds: 2 * H }],
        unifiedUrlMatches: extra.unified || [],
      },
    },
    devlogs: [{ id: uuid(500 + s.n), title: 'Day 1', body: 'Got the basics working.', creditedSeconds: s.hours * H, createdAt: ago(40) }],
    decisions: [],
    votes: { averageStars: 5.1, round: 1, suggestedMultiplier: 1.1, list: [] },
    flags: extra.flags || [],
    fraudSuggestion: null,
  };
}

class FakeTerra {
  constructor() {
    this.writes = [];
    this.done = new Map(); // sid -> decision
  }
  async me() { return { user: { username: 'demo-reviewer', displayName: 'Demo Reviewer', roles: ['reviewer'], isAdmin: false } }; }
  async counts() { return { review: SHIPS.length - this.done.size }; }
  async weeks() { return [{ number: 3, label: 'Week 1', startDate: ago(100), endDate: ago(-68), rentRequired: true }]; }
  async queue() {
    return SHIPS.filter((s) => !this.done.has(uuid(s.n))).map((s) => ({
      id: uuid(s.n), title: s.title, username: s.user, weekNumber: 3, seconds: s.hours * H, platforms: s.platforms,
      danger: s.n === 9 ? 1 : 0, warn: 0, queuedAt: ago(20 + s.n), claimedBy: null, claimedByMe: false, hold: null, decision: null,
    }));
  }
  async shipment(id) {
    const s = SHIPS.find((x) => uuid(x.n) === id);
    if (!s) throw Object.assign(new Error('Shipment not found'), { status: 404 });
    return detail(s);
  }
  async write(method, path, body) {
    this.writes.push({ method, path, body });
    const m = path.match(/shipment\/([0-9a-f-]{36})\/(changes|reject|send)$/);
    if (m) this.done.set(m[1], m[2]);
    return { ok: true, demo: true };
  }
}

const fakeGitHub = {
  async repo(url) {
    const key = url.replace(/^https:\/\/github\.com\//, '');
    const r = REPOS[key];
    if (!r) return { status: 'missing' };
    const [owner, name] = key.split('/');
    return { status: 'ok', owner, name, fork: false, license: 'MIT', releases: r.releases ?? [], codeBytes: r.codeBytes ?? 48000, readme: r.readme };
  },
};

async function fakeCheckDemo(url) {
  return DEMOS[url] || DEMOS[url + '/'] || { status: 200, ms: 180, broken: false, confident: false, gated: false, finalUrl: url };
}

module.exports = { FakeTerra, fakeGitHub, fakeCheckDemo, SHIPS, uuid };
