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
  ['POST', new RegExp(`^/review/shipment/${ID}/approve$`)],
  ['POST', new RegExp(`^/review/shipment/${ID}/flags/[A-Za-z0-9_%.-]+/dismiss$`)],
];
const UPLOADS = [new RegExp(`^/review/shipment/${ID}/video$`)];
const MAX_VIDEO = 104857600; // Terra's limit: 100 MiB

// The upload answer's shape isn't documented, so take the URL from the likely fields, else any string
// that looks like a video on Terra's asset host. null = not found (and then nothing gets approved).
function videoUrlFrom(data) {
  if (!data || typeof data !== 'object') return null;
  for (const k of ['videoUrl', 'url']) if (typeof data[k] === 'string' && /^https:\/\//.test(data[k])) return data[k];
  for (const v of Object.values(data)) {
    if (typeof v === 'string' && /^https:\/\/[^/]*hackclub[^/]*\/.+\.(mp4|webm|mov)$/i.test(v)) return v;
    if (v && typeof v === 'object') { const u = videoUrlFrom(v); if (u) return u; }
  }
  return null;
}

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

  // Review video upload (multipart, fields in the order Terra's page sends them). `file` is a Blob read
  // from disk, so the video never sits in memory. Sent once, logged without the file.
  upload(p, { file, type, size }) {
    if (!UPLOADS.some((re) => re.test(p))) throw new TerraError(400, `Blanche doesn't upload to ${p}`);
    if (!(size > 0) || size > MAX_VIDEO) throw new TerraError(400, 'The video has to be under 100 MB.');
    return this.paced(async () => {
      const entry = { at: new Date().toISOString(), method: 'UPLOAD', path: p, body: { type, size } };
      try {
        if (!this.token) throw new TerraError(401, 'No Terra token. Add it in Settings.');
        const form = new FormData();
        form.append('outcome', 'small');
        form.append('detail', '');
        form.append('compressMs', '0');
        form.append('sourceBytes', String(size));
        form.append('sourceType', type);
        form.append('file', file, `review.${type.split('/')[1] || 'mp4'}`);
        const r = await fetch(`${API}${p}`, {
          method: 'POST', body: form, redirect: 'manual', signal: AbortSignal.timeout(15 * 60e3),
          headers: { Authorization: `Bearer ${this.token}` },
        });
        const text = await r.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (!r.ok) throw new TerraError(r.status, (data && data.error) || `Terra ${r.status} on the video upload`, data);
        this.log({ ...entry, status: 'ok', answer: data });
        return data;
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

module.exports = { Terra, TerraError, API, SITE, MAX_VIDEO, videoUrlFrom };
