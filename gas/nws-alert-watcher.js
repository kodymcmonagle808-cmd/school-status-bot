// Google Apps Script: external change watcher for school-status-bot.
//
// Five watchers on one free 5-minute Google trigger:
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
//   3. Power outages — polls the BGE/Pepco/Potomac Edison outage feeds and
//      POSTs to /refresh-hook when the county picture changes (bucketed to
//      the nearest 100 customers), so posted storm embeds refresh their
//      outage/roads/weather context within minutes during a storm instead
//      of on the 15-minute cron. Quiet days never ping.
//   4. Road conditions — polls the Maryland CHART incident feed and pings
//      /refresh-hook when the set of meaningful open incidents changes, so
//      the roads lines on posted embeds stay current too.
//   5. HCPSS emails — watches this Google account's Gmail for HCPSS
//      announcement emails (the ones that never reach the status page) and
//      POSTs them to /email-hook, which forwards them into each guild's
//      alert channel. Needs the Gmail permission — after pasting this
//      version, run runWatchers() once manually and approve the new consent
//      prompt. If your HCPSS mail arrives at a different address, forward it
//      to this Gmail, and if the sender isn't @hcpss.org set an EMAIL_QUERY
//      script property (e.g. from:someschoolsender.com).
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
// Quota math: (7 zones + 1 status page + 5 outage feeds + 1 roads feed) x
// 288 runs/day ≈ 4,000 URL fetches/day, well under the consumer Apps Script
// limit of 20,000/day. The Worker is only called when something changed,
// which on most days is zero.

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

// Gmail label marking already-forwarded HCPSS emails, and the search query
// for finding them. Override the query with an EMAIL_QUERY script property if
// your HCPSS emails come from a different sender (check the From address on
// one of them).
var EMAIL_LABEL = 'school-status-bot-forwarded';
var DEFAULT_EMAIL_QUERY = 'from:(hcpss.org OR hcpssnews.com)';

// The only counties the bot can serve — every fingerprint below is filtered
// to these, so a crash in Garrett County or an outage in Delaware never
// pings the Worker. Keep in sync with districts.js counties.
var WATCHED_COUNTIES = [
  'Howard', 'Anne Arundel', 'Baltimore', 'Carroll',
  'Frederick', 'Montgomery', "Prince George's"
];

// Power-outage feeds (same sources the Worker's outage context uses). Counts
// are bucketed to the nearest 100 customers before fingerprinting so meter
// noise doesn't ping; the Worker additionally caps forced refreshes at one
// per 5 minutes and only edits embeds while an alert is active. Each
// utility's `keep` lists that feed's names for the watched counties.
var BGE_COUNTIES_URL = 'https://bge-prod.ifactornotifi.com/report/datafeed/counties';
var KUBRA_UTILITIES = [
  {
    id: 'pepco',
    apiBase: 'https://phi-pepco.ifactornotifi.com/bpu/sc5',
    instanceId: 'bac68083-1c42-44ee-bb3c-6d1c1c026f52',
    viewId: 'ebc719f2-1185-46c2-8bf6-d0a2876c537f',
    reportId: '3a6114a2-76f8-4f13-820e-fef1610dd2d6',
    keep: ['MG', 'PG']
  },
  {
    id: 'pe',
    apiBase: 'https://kubra.io',
    instanceId: '6c715f0e-bbec-465f-98cc-0b81623744be',
    viewId: '5ed3ddf1-3a6f-4cfd-8957-eba54b5baaad',
    reportId: 'f168325d-ae23-407f-8134-b18e1946bf41',
    keep: ['FREDERICK', 'CARROLL', 'MONTGOMERY', 'HOWARD']
  }
];

// Entry point for the timed trigger: all watchers, each shielded so one
// failing never blocks the others.
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
  try {
    checkOutages();
  } catch (e) {
    console.error('Outage check failed: ' + e);
  }
  try {
    checkRoads();
  } catch (e) {
    console.error('Roads check failed: ' + e);
  }
  try {
    checkHcpssEmails();
  } catch (e) {
    console.error('HCPSS email check failed: ' + e);
  }
}

// Watches the outage feeds and pings /refresh-hook when the picture changes,
// so posted storm embeds update their outage/roads/weather context within
// minutes instead of on the 15-minute cron. Skips the run when any feed is
// unreadable (a missing utility would look like a change).
function checkOutages() {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = props.getProperty('WORKER_URL');
  var secret = props.getProperty('NWS_HOOK_SECRET');
  if (!workerUrl || !secret) {
    throw new Error('Set WORKER_URL and NWS_HOOK_SECRET in Script Properties first.');
  }

  var parts = [];

  var bge = UrlFetchApp.fetch(BGE_COUNTIES_URL, {
    headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/json' },
    muteHttpExceptions: true
  });
  if (bge.getResponseCode() !== 200) return;
  var bgeData = JSON.parse(bge.getContentText()) || {};
  (bgeData.counties || []).forEach(function (c) {
    if (c && c.county && WATCHED_COUNTIES.indexOf(c.county) !== -1) {
      parts.push('bge:' + c.county + '=' + bucket(c.customersOut));
    }
  });

  for (var i = 0; i < KUBRA_UTILITIES.length; i++) {
    var u = KUBRA_UTILITIES[i];
    var cs = UrlFetchApp.fetch(
      u.apiBase + '/stormcenter/api/v1/stormcenters/' + u.instanceId + '/views/' + u.viewId + '/currentState',
      { headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/json' }, muteHttpExceptions: true }
    );
    if (cs.getResponseCode() !== 200) return;
    var igd = ((JSON.parse(cs.getContentText()) || {}).data || {}).interval_generation_data;
    if (!igd) return;
    var rep = UrlFetchApp.fetch('https://kubra.io/' + igd + '/public/reports/' + u.reportId + '_report.json', {
      headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/json' },
      muteHttpExceptions: true
    });
    if (rep.getResponseCode() !== 200) return;
    var areas = (((JSON.parse(rep.getContentText()) || {}).file_data) || {}).areas || [];
    areas.forEach(function (a) {
      if (a && a.name && u.keep.indexOf(a.name) !== -1) {
        parts.push(u.id + ':' + a.name + '=' + bucket(a.cust_a && a.cust_a.val));
      }
    });
  }

  var fingerprint = md5Hex(parts.sort().join('|'));
  var previous = props.getProperty('fp_outages');
  if (previous === fingerprint) return;

  if (previous === null) {
    props.setProperty('fp_outages', fingerprint); // first run: baseline only
    return;
  }

  var ping = UrlFetchApp.fetch(workerUrl.replace(/\/+$/, '') + '/refresh-hook', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: '{}',
    muteHttpExceptions: true
  });
  var code = ping.getResponseCode();
  if (code >= 200 && code < 300) {
    props.setProperty('fp_outages', fingerprint);
    console.log('Pinged worker: outage picture changed.');
  } else {
    console.error('Refresh hook ping failed: ' + code + ' ' + ping.getContentText());
  }
}

// Rounds an outage count to the nearest 100 so meter noise never fingerprints
// as a change.
function bucket(n) {
  return Math.round((Number(n) || 0) / 100) * 100;
}

// Watches Maryland CHART road incidents (same feed and meaningful-incident
// filter as the Worker's roads context) and pings /refresh-hook when the
// watched counties' set of open incidents changes.
var CHART_INCIDENTS_URL = 'https://chart.maryland.gov/DataFeeds/GetIncidentXml';
var ROAD_TYPE_RE = /weather|closure|collision|injury|damage|debris|flood/i;
var ROAD_DESC_RE = /\b(snow|ice|icy|sleet|flood(?:ed|ing)?|closed|closure|crash|collision|jack-?knif\w*|overturn\w*|downed (?:tree|wire|pole)|tree down|wires? down)\b/i;

function checkRoads() {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = props.getProperty('WORKER_URL');
  var secret = props.getProperty('NWS_HOOK_SECRET');
  if (!workerUrl || !secret) {
    throw new Error('Set WORKER_URL and NWS_HOOK_SECRET in Script Properties first.');
  }

  var resp = UrlFetchApp.fetch(CHART_INCIDENTS_URL, {
    headers: { 'User-Agent': NWS_USER_AGENT },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) return;
  var xml = resp.getContentText();

  var parts = [];
  var blocks = xml.match(/<Incident>[\s\S]*?<\/Incident>/g) || [];
  blocks.forEach(function (block) {
    function tag(name) {
      var m = block.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
      return m ? m[1].trim() : '';
    }
    if (tag('closed') === 'true') return;
    var county = tag('county');
    var type = tag('incidentType');
    var desc = tag('description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    var alertFlag = tag('trafficAlert') === 'true';
    if (!county || !desc) return;
    // Only the counties the bot serves — statewide incidents churn constantly
    // and would ping on nearly every run.
    if (WATCHED_COUNTIES.indexOf(county) === -1) return;
    if (!alertFlag && !ROAD_TYPE_RE.test(type) && !ROAD_DESC_RE.test(desc)) return;
    parts.push(county + '|' + type + '|' + desc.slice(0, 120));
  });

  var fingerprint = md5Hex(parts.sort().join('~'));
  var previous = props.getProperty('fp_roads');
  if (previous === fingerprint) return;

  if (previous === null) {
    props.setProperty('fp_roads', fingerprint); // first run: baseline only
    return;
  }

  var ping = UrlFetchApp.fetch(workerUrl.replace(/\/+$/, '') + '/refresh-hook', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: '{}',
    muteHttpExceptions: true
  });
  var code = ping.getResponseCode();
  if (code >= 200 && code < 300) {
    props.setProperty('fp_roads', fingerprint);
    console.log('Pinged worker: road incidents changed.');
  } else {
    console.error('Roads refresh ping failed: ' + code + ' ' + ping.getContentText());
  }
}

// Forwards HCPSS announcement emails from this Google account's inbox to the
// Worker's /email-hook, which posts them to the Discord alert channels.
// Threads are labeled only after the Worker acks, so a failed delivery is
// retried next run; the Worker dedupes by Gmail message id, so a retry can
// never double-post. First run labels existing matches without forwarding
// (baseline), so installing this never replays old mail.
function checkHcpssEmails() {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = props.getProperty('WORKER_URL');
  var secret = props.getProperty('NWS_HOOK_SECRET');
  if (!workerUrl || !secret) {
    throw new Error('Set WORKER_URL and NWS_HOOK_SECRET in Script Properties first.');
  }

  var label = GmailApp.getUserLabelByName(EMAIL_LABEL) || GmailApp.createLabel(EMAIL_LABEL);
  var query = '(' + (props.getProperty('EMAIL_QUERY') || DEFAULT_EMAIL_QUERY) + ')' +
    ' newer_than:2d -label:' + EMAIL_LABEL;
  var threads = GmailApp.search(query, 0, 10);
  if (!threads.length) return;

  var baselineDone = props.getProperty('email_baseline_done') === 'yes';
  if (!baselineDone) {
    threads.forEach(function (t) { t.addLabel(label); });
    props.setProperty('email_baseline_done', 'yes');
    console.log('Email baseline recorded: ' + threads.length + ' existing thread(s) labeled, not forwarded.');
    return;
  }

  threads.forEach(function (thread) {
    try {
      var allOk = true;
      thread.getMessages().forEach(function (msg) {
        var resp = UrlFetchApp.fetch(workerUrl.replace(/\/+$/, '') + '/email-hook', {
          method: 'post',
          contentType: 'application/json',
          headers: { Authorization: 'Bearer ' + secret },
          payload: JSON.stringify({
            id: msg.getId(),
            subject: msg.getSubject(),
            body: msg.getPlainBody().trim().slice(0, 3500),
            receivedAt: msg.getDate().getTime()
          }),
          muteHttpExceptions: true
        });
        var code = resp.getResponseCode();
        if (code < 200 || code >= 300) {
          allOk = false;
          console.error('Email hook ping failed: ' + code + ' ' + resp.getContentText());
        }
      });
      if (allOk) {
        thread.addLabel(label);
        console.log('Forwarded email thread: ' + thread.getFirstMessageSubject());
      }
    } catch (e) {
      console.error('Email thread forward failed: ' + e);
    }
  });
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
