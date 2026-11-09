// Terra reviewer API client (see docs/terra-admin-api.md).
// Reads are paced under Terra's 100 requests/minute. Writes are limited to the list below,
// are sent exactly once (a decision that timed out may still have landed), and are logged.
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.terra.hackclub.com';
const SITE = 'https://terra.hackclub.com';
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const WRITES = [
  ['POST', new RegExp(`^/review/shipment/${ID}/claim$`)],
  ['DELETE', new RegExp(`^/review/shipment/${ID}/claim$`)],
  ['POST', new RegExp(`^/review/shipment/${ID}/claim/heartbeat$`)],
  ['POST', new RegExp(`^/review/shipment/${ID}/(changes|reject|send)$`)],
  ['POST', new RegExp(`^/review/project/${ID}/notes$`)],
];

class TerraError extends Error {
  constructor(status, msg, body) {
    super(msg);
    this.status = status;
    this.body = body;
  }
}

class Terra {
  constructor({ token, logFile, gapMs = 650 }) {
    this.token = token;
    this.logFile = logFile;
    this.gapMs = gapMs;
    this.chain = Promise.resolve();
    this.nextAt = 0;
  }

  // one request at a time, at least gapMs apart
  paced(fn) {
    const run = this.chain.then(async () => {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        this.nextAt = Date.now() + this.gapMs;
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }

  async raw(method, p, { query, body } = {}) {
    if (!this.token) throw new TerraError(401, 'No Terra token. Add it in Settings.');
    const q = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== ''))}` : '';
    const r = await fetch(`${API}${p}${q}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const remaining = Number(r.headers.get('x-ratelimit-remaining') ?? NaN);
    if (remaining < 10) this.nextAt = Math.max(this.nextAt, Date.now() + 8000);
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) {
      const msg = (data && data.error) || (r.status === 401 ? 'Terra token is wrong or expired' : r.status === 403 ? "Your account can't do this" : `Terra ${r.status}`);
      throw new TerraError(r.status, msg, data);
    }
    return data;
  }

  get(p, query) {
    return this.paced(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.raw('GET', p, { query });
        } catch (e) {
          if (e.status === 429 && attempt < 3) {
            await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
    });
  }

  write(method, p, body, query) {
    if (!WRITES.some(([m, re]) => m === method && re.test(p))) throw new TerraError(400, `Blanche doesn't send ${method} ${p}`);
    return this.paced(async () => {
      const entry = { at: new Date().toISOString(), method, path: p, query, body };
      try {
        const answer = await this.raw(method, p, { body, query });
        this.log({ ...entry, status: 'ok', answer });
        return answer;
      } catch (e) {
        this.log({ ...entry, status: e.status || 'no answer', error: e.message, answer: e.body });
        throw e;
      }
    });
  }

  log(entry) {
    if (!this.logFile) return;
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
  }

  me() { return this.get('/auth/me'); }
  counts() { return this.get('/review/counts'); }
  weeks() { return this.get('/review/weeks'); }
  async queue(queue = 'review', filter = 'waiting') {
    const d = await this.get('/review/queue', { queue, filter });
    return d.items || d || [];
  }
  shipment(id) { return this.get(`/review/shipment/${id}`); }
}

module.exports = { Terra, TerraError, API, SITE };
