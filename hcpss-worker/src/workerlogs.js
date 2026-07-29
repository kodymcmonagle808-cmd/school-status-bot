// The System Logs web page: GET /logs.
//
// Everything the Worker does is already written to Cloudflare's log store by
// src/actionlog.js as `ACT|<iso>|<level>|<guild>|<text>` lines, at zero KV
// cost. This module reads them back out through the Workers Observability API
// — the same query gas/showLogs() runs — and renders them as a web page.
//
// Why a page and not an embed: the panel used to dump the KV log array into an
// embed description with no clamp. At 25 lines of `✅ HCPSS status check
// posted … [Jump to Message](…)` that description measured 4,949 characters
// against Discord's 4,096 limit, so Discord rejected the interaction response
// with a 400 and the click showed "The application did not respond". A page
// has no such ceiling, holds far more than 25 lines, and needs no KV at all.
//
// Access: the panel mints a signed, short-lived link (HMAC over guild + scope
// + expiry). There is no login — the link *is* the credential — so it expires
// in 30 minutes and the page is served no-store, noindex. A guild-scoped link
// shows that guild's lines plus Worker-wide ones; the owner's link shows every
// guild, since the owner already sees all servers on the Worker Updates page.

const OBSERVABILITY_URL_PATH = '/workers/observability/telemetry/query';
// Matches `name` in wrangler.toml — the service tag Workers Logs files events
// under. Overridable so a renamed/preview Worker can still read its own logs.
const DEFAULT_SERVICE = 'hcpss-worker';

export const LOGS_PATH = '/logs';
export const LOGS_LINK_TTL_MS = 30 * 60 * 1000;
const DEFAULT_HOURS = 6;
const MAX_HOURS = 48;
// Matches the limit gas/showLogs() has been running against this API. The
// events come back newest-first, so hitting the ceiling costs the oldest end of
// the window — which the page says out loud rather than silently truncating.
const MAX_EVENTS = 200;

// ── link signing ────────────────────────────────────────────────────────────
// The link is the only credential, so it is signed with a secret that never
// leaves the Worker. DISCORD_BOT_TOKEN is always set (the bot cannot run
// without it), which keeps this from needing a new secret in the deploy;
// LOGS_TOKEN_SECRET overrides it if one is ever added.
function signingKeyMaterial(env) {
  return String((env && (env.LOGS_TOKEN_SECRET || env.DISCORD_BOT_TOKEN)) || '');
}

function tokenPayload(guildId, scope, exp) {
  return `logs.v1.${guildId || '-'}.${scope}.${exp}`;
}

async function hmacHex(keyMaterial, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(keyMaterial), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Length-independent, value-constant comparison of two hex strings.
function timingSafeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// `t=<guild>.<scope>.<exp>.<sig>`; scope 'a' sees every guild, 'g' only its own.
export async function mintLogsToken(env, { guildId = '', all = false, now = Date.now(), ttlMs = LOGS_LINK_TTL_MS } = {}) {
  const material = signingKeyMaterial(env);
  if (!material) return null;
  const scope = all ? 'a' : 'g';
  const exp = now + ttlMs;
  const g = guildId || '-';
  const sig = await hmacHex(material, tokenPayload(g, scope, exp));
  return `${g}.${scope}.${exp}.${sig}`;
}

// Returns { ok:true, guildId, all, exp } or { ok:false, reason }. Never throws.
export async function verifyLogsToken(env, token, now = Date.now()) {
  const material = signingKeyMaterial(env);
  if (!material) return { ok: false, reason: 'not-configured' };
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };
  const [g, scope, expRaw, sig] = parts;
  if (scope !== 'a' && scope !== 'g') return { ok: false, reason: 'malformed' };
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed' };

  // Verify before checking expiry so a tampered timestamp can't be told apart
  // from an expired one.
  let expected;
  try {
    expected = await hmacHex(material, tokenPayload(g, scope, exp));
  } catch {
    return { ok: false, reason: 'not-configured' };
  }
  if (!timingSafeEqual(expected, sig)) return { ok: false, reason: 'bad-signature' };
  if (now > exp) return { ok: false, reason: 'expired' };

  return { ok: true, guildId: g === '-' ? '' : g, all: scope === 'a', exp };
}

export function publicBaseUrl(env) {
  return String((env && env.PUBLIC_BASE_URL) || '').replace(/\/+$/, '');
}

// Absolute, ready-to-click URL. Returns null when the base URL or the signing
// secret is missing, so callers can say so instead of handing out a dead link.
export async function buildLogsUrl(env, { guildId = '', all = false, hours = DEFAULT_HOURS, filter = 'actions', now = Date.now() } = {}) {
  const base = publicBaseUrl(env);
  if (!base) return null;
  const token = await mintLogsToken(env, { guildId, all, now });
  if (!token) return null;
  const params = new URLSearchParams({ t: token, h: String(hours), f: filter });
  return `${base}${LOGS_PATH}?${params.toString()}`;
}

// ── reading the log store ───────────────────────────────────────────────────

// Pulls the human-readable text out of one Workers Logs event. The shape varies
// by how the line was produced (console.log vs. an uncaught throw), so this
// checks the known locations and falls back to empty. Mirrors logEventMessage()
// in gas/nws-alert-watcher.js.
export function logEventMessage(ev) {
  if (!ev) return '';
  if (typeof ev.message === 'string' && ev.message) return ev.message;

  const src = ev.source || {};
  if (typeof src.message === 'string' && src.message) return src.message;

  const args = src.arguments || ev.arguments;
  if (Array.isArray(args) && args.length) {
    return args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  }

  const meta = ev.$metadata || {};
  if (typeof meta.message === 'string' && meta.message) return meta.message;
  if (typeof meta.error === 'string' && meta.error) return `ERROR ${meta.error}`;

  return '';
}

// Splits an actionlog line back into its parts. Anything that isn't an ACT|
// line (a bare console.error, an uncaught exception) comes back as a
// 'console' entry so the page still shows it — those are exactly the lines
// worth seeing when something is broken.
export function parseLogEvent(ev) {
  const message = logEventMessage(ev);
  if (!message) return null;
  const evTs = Number(ev && ev.timestamp) || 0;

  const bits = message.split('|');
  if (bits[0] === 'ACT' && bits.length >= 5) {
    const ts = Date.parse(bits[1]);
    return {
      ts: Number.isFinite(ts) ? ts : evTs,
      level: bits[2] === 'error' || bits[2] === 'detail' ? bits[2] : 'info',
      guildId: bits[3] === '-' ? '' : bits[3],
      text: bits.slice(4).join('|'),
      action: true
    };
  }

  const level = String((ev && ev.$metadata && ev.$metadata.level) || '').toLowerCase();
  return {
    ts: evTs,
    level: level === 'error' || level === 'warn' ? 'error' : 'console',
    guildId: '',
    text: message,
    action: false
  };
}

// Filters and orders raw events for display. `guildId` empty + all:false means
// only Worker-wide lines. Newest first.
export function selectLogEntries(events, { guildId = '', all = false, filter = 'actions' } = {}) {
  const entries = [];
  for (const ev of Array.isArray(events) ? events : []) {
    const entry = parseLogEvent(ev);
    if (!entry) continue;
    // A guild-scoped link must not leak another server's activity. Worker-wide
    // lines (guildId '') are operational, not per-server, so they stay.
    if (!all && entry.guildId && entry.guildId !== guildId) continue;
    if (filter === 'errors' && entry.level !== 'error') continue;
    if (filter === 'actions' && entry.level === 'detail') continue;
    entries.push(entry);
  }
  entries.sort((a, b) => b.ts - a.ts);
  return entries;
}

// Queries Workers Logs. Shapes: { ok:true, events } | { ok:false, reason, hint }.
// Never throws — the page has to render something either way.
export async function queryWorkerLogs(env, { fromMs, toMs, limit = MAX_EVENTS } = {}) {
  const token = env && env.CF_API_TOKEN;
  const account = env && env.CF_ACCOUNT_ID;
  if (!token || !account) {
    return { ok: false, reason: 'CF_API_TOKEN and CF_ACCOUNT_ID are not set on the Worker.' };
  }

  const service = String((env && env.WORKER_SERVICE_NAME) || DEFAULT_SERVICE);
  const body = {
    queryId: 'school-status-bot-panel',
    timeframe: { from: fromMs, to: toMs },
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: service }],
      limit
    },
    view: 'events',
    limit
  };

  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${OBSERVABILITY_URL_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let json = null;
    try { json = await r.json(); } catch {}

    if (!r.ok || (json && json.success === false)) {
      const apiError = json && Array.isArray(json.errors) && json.errors[0]
        ? String(json.errors[0].message || json.errors[0].code || '')
        : `HTTP ${r.status}`;
      // The deploy token needs a permission the KV analytics gauge doesn't, so
      // this is the one failure worth naming precisely — otherwise it reads as
      // "logs are broken" when the fix is one checkbox on the token.
      const hint = (r.status === 403 || r.status === 401 || /unauthor|permission|denied/i.test(apiError))
        ? 'The Cloudflare API token needs Account → Workers Observability → Read.'
        : '';
      return { ok: false, reason: apiError.slice(0, 200), hint };
    }

    const events = ((json && json.result && json.result.events) || {}).events || [];
    return { ok: true, events, capped: events.length >= limit };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || 'log query failed').slice(0, 200) };
  }
}

// ── rendering ───────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const LEVEL_META = {
  error: { label: 'error', color: '#e74c3c' },
  info: { label: 'action', color: '#3498db' },
  detail: { label: 'detail', color: '#95a5a6' },
  console: { label: 'console', color: '#8e6fd8' }
};

// Log lines are written for Discord, so they carry its markdown. Escape first,
// then re-introduce only the three inline forms the bot actually emits.
export function formatLogText(text) {
  let out = escapeHtml(text);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label, href) => `<a href="${href}" rel="noreferrer noopener">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
}

function easternStamp(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    hour12: true
  }).format(new Date(ms));
}

// Pure renderer; exported for tests. `token` is the caller's own signed token,
// threaded through so the filter/window links keep working.
export function renderLogsPage({ entries, hours, filter, all, guildId, expiresAtMs, error, hint, capped = false, token = '', now = Date.now() }) {
  const tabs = [
    { f: 'actions', label: 'Actions' },
    { f: 'all', label: 'Everything' },
    { f: 'errors', label: 'Errors only' }
  ];
  const spans = [2, 6, 24, 48];

  // Every link has to carry the signed token forward, so they're built from the
  // live query string rather than assembled from scratch.
  const linkFor = (params) => {
    const q = new URLSearchParams(params);
    return `${LOGS_PATH}?${q.toString()}`;
  };
  const baseParams = (over) => ({ t: token, h: String(hours), f: filter, ...over });

  const filterNav = tabs.map(t =>
    `<a class="chip${t.f === filter ? ' on' : ''}" href="${escapeHtml(linkFor(baseParams({ f: t.f })))}">${t.label}</a>`
  ).join('');
  const spanNav = spans.map(h =>
    `<a class="chip${h === hours ? ' on' : ''}" href="${escapeHtml(linkFor(baseParams({ h: String(h) })))}">${h}h</a>`
  ).join('');

  let bodyHtml;
  if (error) {
    bodyHtml = `<div class="notice err"><strong>Could not read the log store.</strong><br>${escapeHtml(error)}` +
      `${hint ? `<br><span class="hint">${escapeHtml(hint)}</span>` : ''}</div>`;
  } else if (!entries.length) {
    bodyHtml = `<div class="notice">Nothing logged in the last ${hours} hour(s)` +
      `${filter === 'errors' ? ' matching "errors only"' : ''}. ` +
      `The Worker only logs when it does something — quiet is the normal state.</div>`;
  } else {
    bodyHtml = `<ol class="log">` + entries.map(e => {
      const meta = LEVEL_META[e.level] || LEVEL_META.info;
      return `<li class="row ${e.level}">` +
        `<span class="when">${escapeHtml(easternStamp(e.ts))}</span>` +
        `<span class="lvl" style="--lvl:${meta.color}">${meta.label}</span>` +
        `<span class="msg">${formatLogText(e.text)}` +
        `${all && e.guildId ? `<span class="gid">server ${escapeHtml(e.guildId)}</span>` : ''}</span>` +
        `</li>`;
    }).join('') + `</ol>`;
  }

  const minsLeft = Math.max(0, Math.round((Number(expiresAtMs) - now) / 60000));
  const scopeNote = all
    ? 'Owner link — every server.'
    : guildId ? `Scoped to server ${escapeHtml(guildId)} plus Worker-wide activity.` : 'Worker-wide activity.';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>School Status — System Logs</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5;
         max-width: 62rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  .sub { font-size: .85rem; opacity: .7; margin: 0 0 1.25rem; }
  nav { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: .5rem; align-items: center; }
  nav .lab { font-size: .8rem; opacity: .6; margin-right: .1rem; }
  .chip { font-size: .82rem; text-decoration: none; padding: .2rem .6rem; border-radius: 999px;
          border: 1px solid rgba(127,127,127,.4); color: inherit; }
  .chip.on { background: rgba(127,127,127,.22); font-weight: 600; }
  .log { list-style: none; margin: 1.25rem 0 0; padding: 0; }
  .row { display: grid; grid-template-columns: 9.5rem 5rem 1fr; gap: .6rem; align-items: baseline;
         padding: .45rem .3rem; border-top: 1px solid rgba(127,127,127,.18); }
  .row:last-child { border-bottom: 1px solid rgba(127,127,127,.18); }
  .row.error .msg { color: #e74c3c; }
  .row.detail { opacity: .72; }
  .when { font-size: .8rem; opacity: .65; font-variant-numeric: tabular-nums; }
  .lvl { font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; font-weight: 700;
         color: var(--lvl); }
  .msg { overflow-wrap: anywhere; }
  .gid { display: inline-block; margin-left: .5rem; font-size: .72rem; opacity: .6; }
  code { background: rgba(127,127,127,.16); padding: 0 .25rem; border-radius: 3px; font-size: .9em; }
  .notice { margin-top: 1.5rem; padding: .9rem 1.1rem; border-radius: 6px;
            background: rgba(127,127,127,.1); border-left: 5px solid #95a5a6; }
  .notice.err { border-left-color: #e74c3c; }
  .hint { font-size: .85rem; opacity: .8; }
  footer { margin-top: 2.5rem; font-size: .8rem; opacity: .65; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>System Logs</h1>
<p class="sub">Everything the Worker did, straight from Cloudflare's log store. ${scopeNote}</p>
<nav><span class="lab">Show</span>${filterNav}</nav>
<nav><span class="lab">Last</span>${spanNav}</nav>
${capped && !error ? `<div class="notice">Busy window — this is the most recent ${MAX_EVENTS} log events in
the last ${hours}h, so the oldest end is cut off. Narrow the window to see it.</div>` : ''}
${bodyHtml}
<footer>${entries.length} line(s) · times in Eastern · this link expires in ${minsLeft} minute(s), then the
control panel can mint a new one · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></footer>
</body>
</html>`;
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The link is a bearer credential: keep it out of caches, crawlers, and
      // any Referer sent to a jump link the page renders.
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow'
    }
  });
}

function denyPage(reason) {
  const msg = reason === 'expired'
    ? 'This log link has expired. Open <strong>System Logs</strong> in the control panel again for a fresh one — links are good for 30 minutes.'
    : reason === 'not-configured'
      ? 'The log page is not configured on this Worker.'
      : 'This log link is not valid. Open <strong>System Logs</strong> in the control panel to get a working one.';
  return htmlResponse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>School Status — System Logs</title>
<style>:root{color-scheme:light dark}body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
line-height:1.6;max-width:34rem;margin:0 auto;padding:3rem 1.25rem}h1{font-size:1.25rem}</style>
</head><body><h1>System Logs</h1><p>${msg}</p></body></html>`, reason === 'expired' ? 410 : 403);
}

// GET /logs — token in `t`, window in `h`, level filter in `f`.
export async function logsPageResponse(env, url, now = Date.now()) {
  const token = url.searchParams.get('t') || '';
  const auth = await verifyLogsToken(env, token, now);
  if (!auth.ok) return denyPage(auth.reason);

  const hoursRaw = Number(url.searchParams.get('h'));
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(Math.round(hoursRaw), MAX_HOURS) : DEFAULT_HOURS;
  const filterRaw = url.searchParams.get('f');
  const filter = ['all', 'errors', 'actions'].includes(filterRaw) ? filterRaw : 'actions';

  const result = await queryWorkerLogs(env, { fromMs: now - hours * 3600 * 1000, toMs: now });
  const entries = result.ok
    ? selectLogEntries(result.events, { guildId: auth.guildId, all: auth.all, filter })
    : [];

  return htmlResponse(renderLogsPage({
    entries,
    hours,
    filter,
    all: auth.all,
    guildId: auth.guildId,
    expiresAtMs: auth.exp,
    error: result.ok ? '' : result.reason,
    hint: result.ok ? '' : result.hint,
    capped: !!result.capped,
    token,
    now
  }));
}
