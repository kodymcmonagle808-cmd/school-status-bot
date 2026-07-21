// Google Apps Script: NWS alert change watcher for school-status-bot.
//
// Polls the NWS active-alerts feed for every county zone the bot can serve
// and POSTs to the Worker's /nws-hook endpoint only when a zone's alert set
// actually changes. Google runs the timed trigger for free, so the Worker's
// own cron scan can drop to an hourly safety net (it does automatically once
// NWS_HOOK_SECRET is configured on the Worker).
//
// Setup (one time, ~5 minutes):
//   1. Go to https://script.google.com → New project, name it "nws-alert-watcher".
//   2. Replace the default Code.gs content with this file.
//   3. Project Settings (gear icon) → Script Properties → add:
//        WORKER_URL       = https://hcpss-worker.kodymcmonagle808.workers.dev
//        NWS_HOOK_SECRET  = <the same secret you set on the Worker/GitHub>
//   4. In the editor, run setupTriggers() once and grant the permissions
//      it asks for (external requests + triggers).
//   5. Done — checkNwsAlerts() now runs every 5 minutes. Executions page
//      shows each run; testPing() verifies the Worker connection.
//
// Quota math: 7 zones x 288 runs/day ≈ 2,016 URL fetches/day, well under the
// consumer Apps Script limit of 20,000/day. The Worker is only called when
// something changed, which on most days is zero times.

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

// Entry point for the timed trigger. Each zone is independent: a bad fetch
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
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, parts.join('|'));
  return digest.map(function (b) { return ((b + 256) % 256).toString(16); }).join('');
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
  ScriptApp.newTrigger('checkNwsAlerts').timeBased().everyMinutes(5).create();
  console.log('Trigger installed: checkNwsAlerts every 5 minutes.');
}

// Optional: run manually to verify the Worker URL + secret are right.
// Expect a log line ending in {"ok":true,"zone":"MDC027"}.
function testPing() {
  var props = PropertiesService.getScriptProperties();
  pingWorker(props.getProperty('WORKER_URL'), props.getProperty('NWS_HOOK_SECRET'), 'MDC027');
}
