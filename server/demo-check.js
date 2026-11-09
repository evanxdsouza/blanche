// Opens a ship's demo link the way a reviewer would and reports whether it works.
// The URL comes from a player, so it is never fetched if it (or any redirect) resolves to a
// private, loopback or link-local address: Blanche runs next to your token.
const dns = require('node:dns/promises');
const net = require('node:net');

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

const PROXIED = () => process.env.NODE_USE_ENV_PROXY === '1' && !!(process.env.HTTPS_PROXY || process.env.https_proxy);

async function assertPublic(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try {
    addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  } catch (e) {
    // behind an HTTPS proxy there may be no local DNS at all; the proxy resolves the name, so let it try
    if (PROXIED() && (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN')) return;
    throw e;
  }
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) {
    const e = new Error('private address');
    e.code = 'PRIVATE';
    throw e;
  }
}

const LOGIN = /\/(login|log-in|signin|sign-in|sign_in|auth|authenticate|session\/new|accounts\/login)(\/|$|\?)/i;

// -> { status, ms, finalUrl, broken, confident, gated, error }
async function checkDemo(url, { timeoutMs = 35000, lookup = assertPublic } = {}) {
  const started = Date.now();
  let current = url;
  try {
    for (let hop = 0; hop < 6; hop++) {
      const u = new URL(current);
      if (!/^https?:$/.test(u.protocol)) return { status: 'bad-scheme', broken: true, confident: true, ms: 0 };
      await lookup(u.hostname);
      const left = timeoutMs - (Date.now() - started);
      const r = await fetch(u, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(Math.max(1000, left)),
        headers: { 'User-Agent': 'Mozilla/5.0 (Blanche review checker)', Accept: 'text/html,*/*' },
      });
      r.body?.cancel().catch(() => {});
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        current = new URL(r.headers.get('location'), u).href;
        continue;
      }
      const ms = Date.now() - started;
      const s = r.status;
      return {
        status: s, ms, finalUrl: current,
        // 404/410 is a dead link. 5xx may be a sleeping host. 401/403/429 is usually bot blocking, not broken.
        broken: s === 404 || s === 410 || s >= 500,
        confident: s === 404 || s === 410,
        gated: s === 401 || LOGIN.test(new URL(current).pathname),
      };
    }
    return { status: 'redirect-loop', broken: true, confident: false, ms: Date.now() - started };
  } catch (e) {
    const code = e.code || e.cause?.code || e.name;
    const ms = Date.now() - started;
    if (code === 'PRIVATE') return { status: 'private', broken: true, confident: true, error: 'resolves to a private address', ms };
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { status: 'dns', broken: true, confident: code === 'ENOTFOUND', error: 'domain does not resolve', ms };
    if (code === 'TimeoutError' || code === 'AbortError') return { status: 'timeout', broken: true, confident: false, error: `no answer in ${Math.round(timeoutMs / 1000)}s`, ms };
    // anything else (TLS trouble, a proxy refusing, connection reset) says nothing certain about the demo
    return { status: 'unknown', broken: false, confident: false, error: String(code || e.message), ms };
  }
}

module.exports = { checkDemo, privateIp };
