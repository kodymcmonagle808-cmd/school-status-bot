// Google Apps Script: external change watcher for school-status-bot.
//
// Two watchers on one free 5-minute Google trigger:
//   1. NWS alerts — polls the active-alerts feed for every county zone the
//      bot can serve and POSTs to the Worker's /nws-hook endpoint when a
//      zone's alert set changes. The Worker's own cron scan drops to an
//      hourly safety net automatically once NWS_HOOK_SECRET is configured.
//   2. HCPSS status page — polls https://status.hcpss.org and POSTs to
//      /status-hook when the status block changes. The Worker then runs a
//      change-only check immediately: it re-scrapes with its real parser and
//      posts only to guilds whose status actually changed, so a cosmetic
//      page edit never posts anything. Panel-scheduled posts keep firing at
//      their configured times no matter what.
//
// Setup (one time, ~5 minutes):
//   1. Go to https://script.google.com → New project, name it "nws-alert-watcher".
//   2. Replace the default Code.gs content with this file.
//   3. Project Settings (gear icon) → Script Properties → add:
//        WORKER_URL       = https://hcpss-worker.kodymcmonagle808.workers.dev
//        NWS_HOOK_SECRET  = <the same secret you set on the Worker/GitHub>
//   4. In the editor, run setupTriggers() once and grant the permissions
//      it asks for (external requests + triggers). Re-run it after pasting
//      an updated copy of this file — it replaces the old triggers.
//   5. Done — runWatchers() now runs every 5 minutes. Executions page
//      shows each run; testPing() verifies the Worker connection.
//
// Quota math: (7 zones + 1 status page) x 288 runs/day ≈ 2,300 URL
// fetches/day, well under the consumer Apps Script limit of 20,000/day. The
// Worker is only called when something changed, which on most days is zero.

// Keep in sync with DEFAULT_NWS_ZONE (weather.js) and the nwsZone values in
// districts.js: Howard + the six neighboring districts guilds can follow.
var NWS_ZONES = [
  'MDC027', // Howard (default)
  'MDC003', // Anne Arundel
  'MDC005', // Baltimore County
  'MDC013', // Carroll
  'MDC021', // Frederick
  'MDC031', // Montgomery
  'MDC033'  // Prince George's
];

var NWS_USER_AGENT = 'school-status-bot gas watcher (github.com/kodymcmonagle808-cmd/school-status-bot)';

var HCPSS_STATUS_URL = 'https://status.hcpss.org';

// Entry point for the timed trigger: both watchers, each shielded so one
// failing never blocks the other.
function runWatchers() {
  try {
    checkHcpssStatus();
  } catch (e) {
    console.error('HCPSS status check failed: ' + e);
  }
  try {
    checkNwsAlerts();
  } catch (e) {
    console.error('NWS alerts check failed: ' + e);
  }
}

// Watches the HCPSS status page. Fingerprints the status-block section (the
// exact region the Worker's scraper parses); if the site redesigns and that
// section disappears, falls back to the page's visible text so changes are
// still caught — worst case that pings more often, and the Worker re-checks
// with its real parser and stays silent unless the parsed status changed.
function checkHcpssStatus() {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = props.getProperty('WORKER_URL');
  var secret = props.getProperty('NWS_HOOK_SECRET');
  if (!workerUrl || !secret) {
    throw new Error('Set WORKER_URL and NWS_HOOK_SECRET in Script Properties first.');
  }

  var resp = UrlFetchApp.fetch(HCPSS_STATUS_URL, {
    headers: { 'User-Agent': NWS_USER_AGENT },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    console.error('HCPSS status fetch returned ' + resp.getResponseCode());
    return; // transient; try again next run
  }
  var html = resp.getContentText();

  var section = html.match(/<section[^>]+id=["']status-block["'][^>]*>([\s\S]*?)<\/section>/i);
  var content = section
    ? section[1]
    : html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  var text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  var fingerprint = md5Hex(text);

  var previous = props.getProperty('fp_hcpss_status');
  if (previous === fingerprint) return;

  if (previous === null) {
    // First run: baseline only, no ping (the current status was already posted).
    props.setProperty('fp_hcpss_status', fingerprint);
    return;
  }

  var ping = UrlFetchApp.fetch(workerUrl.replace(/\/+$/, '') + '/status-hook', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: '{}',
    muteHttpExceptions: true
  });
  var code = ping.getResponseCode();
  if (code >= 200 && code < 300) {
    props.setProperty('fp_hcpss_status', fingerprint);
    console.log('Pinged worker: HCPSS status page changed.');
  } else {
    console.error('Status hook ping failed: ' + code + ' ' + ping.getContentText());
  }
}

function md5Hex(text) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text);
  return digest.map(function (b) { return ((b + 256) % 256).toString(16); }).join('');
}

// NWS watcher below. Each zone is independent: a bad fetch
// for one zone never blocks the others, and the stored fingerprint is only
// advanced after the Worker acknowledges the ping (so a Worker outage means
// a retry on the next run, not a lost alert).
function checkNwsAlerts() {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = props.getProperty('WORKER_URL');
  var secret = props.getProperty('NWS_HOOK_SECRET');
  if (!workerUrl || !secret) {
    throw new Error('Set WORKER_URL and NWS_HOOK_SECRET in Script Properties first.');
  }

  NWS_ZONES.forEach(function (zone) {
    try {
      var fingerprint = fetchZoneFingerprint(zone);
      if (fingerprint === null) return; // fetch failed; try again next run

      var key = 'fp_' + zone;
      var previous = props.getProperty(key);
      if (previous === fingerprint) return; // nothing changed

      if (previous === null) {
        // First run for this zone: record the baseline without pinging, so
        // installing the script mid-storm doesn't fire 7 stale notices at
        // once. Real changes from here on are pushed.
        props.setProperty(key, fingerprint);
        return;
      }

      if (pingWorker(workerUrl, secret, zone)) {
        props.setProperty(key, fingerprint);
      }
    } catch (e) {
      console.error('Zone ' + zone + ' check failed: ' + e);
    }
  });
}

// Stable digest of a zone's active alert set: alert ids + their last-sent
// timestamps, so both new issuances and meaningful updates change it.
// Returns null when the feed can't be read.
function fetchZoneFingerprint(zone) {
  var resp = UrlFetchApp.fetch('https://api.weather.gov/alerts/active/zone/' + zone, {
    headers: { 'User-Agent': NWS_USER_AGENT, 'Accept': 'application/geo+json' },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    console.error('NWS fetch for ' + zone + ' returned ' + resp.getResponseCode());
    return null;
  }
  var features = (JSON.parse(resp.getContentText()) || {}).features || [];
  var parts = features.map(function (f) {
    var p = (f && f.properties) || {};
    return (f.id || p.id || p.event || '?') + '@' + (p.sent || '');
  }).sort();
  return md5Hex(parts.join('|'));
}

// Tells the Worker this zone's alerts changed. Returns true on a 2xx ack.
function pingWorker(workerUrl, secret, zone) {
  var resp = UrlFetchApp.fetch(workerUrl.replace(/\/+$/, '') + '/nws-hook', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: JSON.stringify({ zone: zone }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    console.error('Worker ping for ' + zone + ' failed: ' + code + ' ' + resp.getContentText());
    return false;
  }
  console.log('Pinged worker: ' + zone + ' changed.');
  return true;
}

// Run once manually to install the 5-minute trigger (replaces any existing
// triggers for this script so re-running never stacks duplicates).
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runWatchers').timeBased().everyMinutes(5).create();
  console.log('Trigger installed: runWatchers (NWS alerts + HCPSS status) every 5 minutes.');
}

// Optional: run manually to verify the Worker URL + secret are right.
// Expect a log line ending in {"ok":true,"zone":"MDC027"}.
function testPing() {
  var props = PropertiesService.getScriptProperties();
  pingWorker(props.getProperty('WORKER_URL'), props.getProperty('NWS_HOOK_SECRET'), 'MDC027');
}
