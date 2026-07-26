// Google Apps Script: external data collector for school-status-bot.
//
// This script owns every steady-state poll. The Worker fetches nothing on a
// schedule any more: it runs the Discord side (interactions, scheduled posts,
// storm mode) and stores what this script hands it. All the "has anything
// changed?" work happens up here, on Google's free 5-minute trigger, where
// polling costs nothing.
//
// How data reaches the Worker: this script fetches each feed, fingerprints
// the part the Worker actually acts on, and — when a fingerprint moves —
// POSTs the raw body it already downloaded to /push-data. The Worker parses
// it with its own parsers and writes the result straight into the cache key
// its readers use.
//
// That last part is the whole point. The older design POSTed "source X
// changed" to /context-hook, the Worker deleted that source's cache, and the
// next reader re-downloaded the same bytes and re-cached them: one KV delete
// plus one KV write plus an outbound fetch, per change. Cloudflare's free
// plan allows 1,000 writes and 1,000 deletes a day, and a quiet summer day
// with a single server was already spending roughly half of each. Handing
// over the body costs one write and nothing else, and the Worker never
// fetches. Parsing stays in the Worker so there is exactly one parser per
// source — this script never has to know what a closure looks like.
//
// What runs on the 5-minute trigger:
//   1. NWS alerts — the active-alerts feed for every county zone the bot can
//      serve. The fingerprint mirrors the Worker's own filter (weather.js
//      summarizeWeatherAlerts), so alerts the Worker discards can never
//      trigger a push; tests/gaswatcher.test.js pins the two together.
//   2. HCPSS status page — https://status.hcpss.org. This one still POSTs to
//      /status-hook rather than /push-data, because a status change is an
//      *action*, not data: the Worker re-scrapes with its real parser and
//      posts to Discord only where the parsed status actually changed.
//      Panel-scheduled posts keep firing at their configured times regardless.
//   3. Power outages — BGE plus the Pepco and Potomac Edison Kubra feeds,
//      bucketed to the nearest 100 customers so meter noise never pushes.
//   4. Road conditions — the Maryland CHART incident feed, filtered to the
//      counties the bot serves.
//   5. Context sources — the six district feeds, the HCPSS news RSS, the NWS
//      snowfall forecast, and AirNow AQI, all fetched in one parallel batch.
//   6. HCPSS emails — this Google account's Gmail, forwarded to /email-hook.
//      Needs the Gmail permission: after pasting this version, run
//      runWatchers() once by hand and approve the new consent prompt. If your
//      HCPSS mail arrives elsewhere, forward it to this Gmail; if the sender
//      isn't @hcpss.org, set an EMAIL_QUERY script property.
//
// Everything from 1, 3, 4 and 5 is batched into a single /push-data request
// per run, so a stormy five minutes where every feed moved still costs the
// Worker one request.
//
// Setup (one time, ~5 minutes):
//   1. Go to https://script.google.com → New project, name it "nws-alert-watcher".
//   2. Replace the default Code.gs content with this file.
//   3. Project Settings (gear icon) → Script Properties → add:
//        WORKER_URL       = https://hcpss-worker.kodymcmonagle808.workers.dev
//        NWS_HOOK_SECRET  = <the same secret you set on the Worker/GitHub>
//      Optional, only needed for showLogs() — see that function's comment:
//        CF_ACCOUNT_ID    = <your Cloudflare account id>
//        CF_API_TOKEN     = <token with Account Analytics + Workers Observability read>
//   4. In the editor, run setupTriggers() once and grant the permissions
//      it asks for (external requests + triggers). Re-run it after pasting
//      an updated copy of this file — it replaces the old triggers.
//   5. Done — runWatchers() now runs every 5 minutes. Executions page
//      shows each run; testPing() verifies the Worker connection, and
//      showLogs() prints what the Worker has been doing.
//
// Quota math: (7 zones + 1 status page + 5 outage feeds + 1 roads feed +
// 11 context-source feeds) x 288 runs/day ≈ 7,200 URL fetches/day, well under
// the consumer Apps Script limit of 20,000/day. The context batch runs
// through UrlFetchApp.fetchAll (parallel), keeping the added trigger runtime
// to a few seconds per run against the 90-minute/day trigger budget.

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

// Entry point for the timed trigger.
//
// Each collector fetches its feeds, compares fingerprints, and — for anything
// that moved — adds the raw body to a shared batch and registers a pending
// fingerprint. Nothing is sent until every collector has run, so one run
// produces at most one /push-data request no matter how much changed. Each
// collector is shielded, so one failing feed never blocks the others.
function runWatchers() {
  var props = PropertiesService.getScriptProperties();
  var batch = { bodies: {}, zones: {}, units: [] };

  try {
    checkHcpssStatus();
  } catch (e) {
    console.error('HCPSS status check failed: ' + e);
  }
  try {
    collectNwsAlerts(props, batch);
  } catch (e) {
    console.error('NWS alerts check failed: ' + e);
  }
  try {
    collectOutages(props, batch);
  } catch (e) {
    console.error('Outage check failed: ' + e);
  }
  try {
    collectRoads(props, batch);
  } catch (e) {
    console.error('Roads check failed: ' + e);
  }
  try {
    collectContextSources(props, batch);
  } catch (e) {
    console.error('Context sources check failed: ' + e);
  }

  try {
    sendBatch(props, batch);
  } catch (e) {
    console.error('Push to Worker failed: ' + e);
  }

  try {
    checkHcpssEmails();
  } catch (e) {
    console.error('HCPSS email check failed: ' + e);
  }
}

// Registers one changed source: the raw bodies to hand over, the property key
// holding its fingerprint, the new fingerprint value, and the source names the
// Worker will report back in `written` once it has stored them.
function stageUnit(batch, fpKey, fingerprint, expect, bodies, zones) {
  var i;
  var keys = Object.keys(bodies || {});
  for (i = 0; i < keys.length; i++) {
    batch.bodies[keys[i]] = bodies[keys[i]];
  }
  keys = Object.keys(zones || {});
  for (i = 0; i < keys.length; i++) {
    batch.zones[keys[i]] = zones[keys[i]];
  }
  batch.units.push({ fpKey: fpKey, fingerprint: fingerprint, expect: expect });
}

// Standard change gate shared by every collector: null parts mean the fetch
// failed (skip this run — a missing feed must never look like a change), and
// the very first fingerprint is recorded as a baseline without pushing, so
// installing this script never replays the current state as if it were new.
// Returns the fingerprint when it should be pushed, or null when it shouldn't.
function changedFingerprint(props, fpKey, parts) {
  if (parts === null) return null;
  var fingerprint = md5Hex(parts.join('|'));
  var previous = props.getProperty(fpKey);
  if (previous === fingerprint) return null;
  if (previous === null) {
    props.setProperty(fpKey, fingerprint); // baseline only
    return null;
  }
  return fingerprint;
}

// Sends everything that changed in one request. A fingerprint is advanced only
// after the Worker confirms it stored that source, so a Worker outage, a parse
// failure, or a partial write all retry on the next run instead of silently
// losing the change.
function sendBatch(props, batch) {
  if (!batch.units.length) return;

  var workerUrl = props.getProperty('WORKER_URL');
  var secret = props.getProperty('NWS_HOOK_SECRET');
  if (!workerUrl || !secret) {
    throw new Error('Set WORKER_URL and NWS_HOOK_SECRET in Script Properties first.');
  }

  var resp = UrlFetchApp.fetch(workerUrl.replace(/\/+$/, '') + '/push-data', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: JSON.stringify({ bodies: batch.bodies, zones: batch.zones }),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    console.error('Push failed: ' + code + ' ' + resp.getContentText());
    return;
  }

  var written = [];
  try {
    written = (JSON.parse(resp.getContentText()) || {}).written || [];
  } catch (e) {
    console.error('Push response was not JSON: ' + resp.getContentText());
    return;
  }

  var advanced = [];
  batch.units.forEach(function (unit) {
    var allStored = unit.expect.every(function (name) {
      return written.indexOf(name) !== -1;
    });
    if (allStored) {
      props.setProperty(unit.fpKey, unit.fingerprint);
      advanced.push(unit.fpKey);
    } else {
      console.error('Worker did not store ' + unit.expect.join(', ') + '; will retry next run.');
    }
  });
  console.log('Pushed ' + advanced.length + ' changed source(s): ' + advanced.join(', '));
}

// Collects the outage feeds and stages the raw reports when the county picture
// changes. Bails on the whole run if any feed is unreadable — a missing
// utility would fingerprint as "everyone's power came back".
function collectOutages(props, batch) {
  var bodies = {};
  var parts = [];

  var bge = UrlFetchApp.fetch(BGE_COUNTIES_URL, {
    headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/json' },
    muteHttpExceptions: true
  });
  if (bge.getResponseCode() !== 200) return;
  bodies.bge = bge.getContentText();
  var bgeData = JSON.parse(bodies.bge) || {};
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
    bodies['kubra_' + u.id] = rep.getContentText();
    var areas = (((JSON.parse(rep.getContentText()) || {}).file_data) || {}).areas || [];
    areas.forEach(function (a) {
      if (a && a.name && u.keep.indexOf(a.name) !== -1) {
        parts.push(u.id + ':' + a.name + '=' + bucket(a.cust_a && a.cust_a.val));
      }
    });
  }

  var fingerprint = changedFingerprint(props, 'fp_outages', parts.sort());
  if (!fingerprint) return;
  stageUnit(batch, 'fp_outages', fingerprint, ['bge', 'outages:pepco', 'outages:pe'], bodies, null);
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

function collectRoads(props, batch) {
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

  var fingerprint = changedFingerprint(props, 'fp_roads', parts.sort());
  if (!fingerprint) return;
  stageUnit(batch, 'fp_roads', fingerprint, ['roads'], { roads: xml }, null);
}

// --- Context sources (district feeds, HCPSS news RSS, snowfall, AQI) ---
//
// These have no dedicated hook: on a real change the Worker just needs its
// KV cache for that source dropped, so it re-fetches live with its own
// parsers on the next read. Fingerprints are built from extracted meaningful
// content only (never raw HTML), mirroring the Worker's parsers, so cosmetic
// page churn doesn't ping. Sources whose fetch failed are skipped for the
// run — a missing feed must never look like a change.

var THRILLSHARE_AACPS_URL = 'https://api.thrillshare.com/api/v4/o/20274/cms/live_feeds?page=1&per_page=15';
var HCPSS_NEWS_FEED_URL = 'https://news.hcpss.org/feed/';
var NWS_POINT_URL = 'https://api.weather.gov/points/39.2156,-76.8582'; // Columbia, MD
var AIRNOW_STATE_URL = 'https://airnowgovapi.com/reportingarea/get_state';

// Keep in sync with COUNTY_REPORTING_AREAS in aqi.js.
var AQI_WATCHED_AREAS = ['Suburban DC', 'Metro Baltimore', 'Maryland Piedmont', 'Northern Virginia and DC'];

function gasStripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectContextSources(props, batch) {
  // The gridpoint forecast URL is resolved once via the points API and kept
  // in Script Properties (NWS grid assignments are effectively static).
  var forecastUrl = props.getProperty('NWS_FORECAST_URL');
  if (!forecastUrl) {
    try {
      var point = UrlFetchApp.fetch(NWS_POINT_URL, {
        headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/geo+json' },
        muteHttpExceptions: true
      });
      if (point.getResponseCode() === 200) {
        forecastUrl = (((JSON.parse(point.getContentText()) || {}).properties) || {}).forecast || '';
        if (forecastUrl) props.setProperty('NWS_FORECAST_URL', forecastUrl);
      }
    } catch (e) {
      console.error('NWS points resolve failed: ' + e);
    }
  }

  var defs = [
    { key: 'aacps', url: THRILLSHARE_AACPS_URL, accept: 'application/json' },
    { key: 'bcps', url: 'https://www.bcps.org/WebServices/UnifiedPublishing/UnifiedPublishingService.asmx/GetActiveAlerts', sharpSchool: true },
    { key: 'ccps3', url: 'https://www.carrollk12.org/fs/post-manager/boards/3/posts/feed' },
    { key: 'ccps63', url: 'https://www.carrollk12.org/fs/post-manager/boards/63/posts/feed' },
    { key: 'fcps', url: 'https://www.fcps.org/WebServices/UnifiedPublishing/UnifiedPublishingService.asmx/GetActiveAlerts', sharpSchool: true },
    { key: 'mcps', url: 'https://api.montgomeryschoolsmd.org/schools/homepageInput', accept: 'application/json' },
    { key: 'pgcps', url: 'https://www.pgcps.org' },
    { key: 'news', url: HCPSS_NEWS_FEED_URL },
    { key: 'aqimd', url: AIRNOW_STATE_URL, form: 'state_code=MD' },
    { key: 'aqidc', url: AIRNOW_STATE_URL, form: 'state_code=DC' }
  ];
  if (forecastUrl) {
    defs.push({ key: 'snowfall', url: forecastUrl, accept: 'application/geo+json' });
  }

  var requests = defs.map(function (d) {
    var headers = { 'User-Agent': NWS_USER_AGENT };
    if (d.accept) headers.Accept = d.accept;
    var req = { url: d.url, headers: headers, muteHttpExceptions: true };
    if (d.sharpSchool) {
      req.method = 'post';
      req.contentType = 'application/json; charset=UTF-8';
      req.payload = '{"returnDummyAlerts":false}';
      headers.Accept = 'application/json, text/javascript, */*; q=0.01';
    } else if (d.form) {
      req.method = 'post';
      req.contentType = 'application/x-www-form-urlencoded';
      req.payload = d.form;
    }
    return req;
  });

  var responses = UrlFetchApp.fetchAll(requests);
  var bodies = {};
  defs.forEach(function (d, i) {
    var r = responses[i];
    bodies[d.key] = r && r.getResponseCode() === 200 ? r.getContentText() : null;
  });

  // Districts share one cache entry in the Worker, so they are staged as one
  // unit: all seven bodies go over together or none do.
  var districtFp = changedFingerprint(props, 'fp_ctx_districts', districtsFingerprintParts(bodies));
  if (districtFp) {
    stageUnit(batch, 'fp_ctx_districts', districtFp, ['districts'], {
      aacps: bodies.aacps,
      bcps: bodies.bcps,
      ccps3: bodies.ccps3,
      ccps63: bodies.ccps63,
      fcps: bodies.fcps,
      mcps: bodies.mcps,
      pgcps: bodies.pgcps
    }, null);
  }

  var newsFp = changedFingerprint(props, 'fp_ctx_news', newsFingerprintParts(bodies.news));
  if (newsFp) {
    stageUnit(batch, 'fp_ctx_news', newsFp, ['news'], { news: bodies.news }, null);
  }

  var snowFp = changedFingerprint(props, 'fp_ctx_snowfall', snowfallFingerprintParts(bodies.snowfall));
  if (snowFp) {
    stageUnit(batch, 'fp_ctx_snowfall', snowFp, ['snowfall'], { snowfall: bodies.snowfall }, null);
  }

  // Both AirNow state feeds are one fingerprint and one unit: the Worker
  // stores them under separate keys, so both must land before the fingerprint
  // advances.
  var aqiFp = changedFingerprint(props, 'fp_ctx_aqi', aqiFingerprintParts(bodies.aqimd, bodies.aqidc, aqiTodayMdy()));
  if (aqiFp) {
    stageUnit(batch, 'fp_ctx_aqi', aqiFp, ['aqi:MD', 'aqi:DC'], {
      aqimd: bodies.aqimd,
      aqidc: bodies.aqidc
    }, null);
  }
}

// One combined fingerprint across all six district feeds. Any unreadable
// required feed skips the run; Carroll tolerates one of its two boards being
// down (mirroring the Worker's fetcher).
function districtsFingerprintParts(bodies) {
  if (!bodies.aacps || !bodies.bcps || !bodies.fcps || !bodies.mcps || !bodies.pgcps) return null;
  if (!bodies.ccps3 && !bodies.ccps63) return null;
  var parts = [];
  try {
    var feeds = (JSON.parse(bodies.aacps) || {}).live_feeds || [];
    feeds.forEach(function (f) {
      parts.push('aacps:' + gasStripHtml(f && f.status) + '@' + ((f && f.publishing_at) || ''));
    });

    parts.push('bcps:' + bodies.bcps.replace(/\s+/g, ' ').trim());
    parts.push('fcps:' + bodies.fcps.replace(/\s+/g, ' ').trim());

    ['ccps3', 'ccps63'].forEach(function (key) {
      var blocks = (bodies[key] || '').match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
      blocks.forEach(function (block) {
        var title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
        var updated = (block.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1] || '';
        parts.push('ccps:' + gasStripHtml(title) + '@' + updated.trim());
      });
    });

    var emsg = (JSON.parse(bodies.mcps) || {}).emsg || '';
    if (!emsg || emsg.indexOf('emer-code-green') !== -1) {
      parts.push('mcps:green');
    } else {
      parts.push('mcps:' + gasStripHtml(emsg.replace(/<span[^>]*class=['"]timestamp['"][^>]*>[\s\S]*?<\/span>/gi, '')));
    }

    var alertSection = bodies.pgcps.match(/<section class="site-alert-component[\s\S]*?<\/section>/);
    parts.push('pgcps:' + (alertSection ? gasStripHtml(alertSection[0]) : 'none'));
  } catch (e) {
    console.error('District fingerprint failed: ' + e);
    return null;
  }
  return parts.sort();
}

// HCPSS news RSS: item titles + publish dates (new posts ping, edits to old
// body text don't matter — the Worker only classifies recent items anyway).
function newsFingerprintParts(body) {
  if (!body) return null;
  var parts = [];
  var items = body.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  items.slice(0, 10).forEach(function (block) {
    var title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    var pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    parts.push(gasStripHtml(title.replace(/<!\[CDATA\[|\]\]>/g, ' ')) + '@' + pubDate.trim());
  });
  return parts;
}

// Snowfall: only the accumulation sentences the Worker extracts — the
// forecast text refreshes constantly, but these change rarely.
function snowfallFingerprintParts(body) {
  if (!body) return null;
  try {
    var periods = ((JSON.parse(body) || {}).properties || {}).periods || [];
    var parts = [];
    periods.slice(0, 4).forEach(function (p) {
      var detail = String((p && p.detailedForecast) || '');
      var sentences = detail.match(/[^.!?]*accumulation[^.!?]*[.!?]/gi) || [];
      if (sentences.length) {
        parts.push(((p && p.name) || '?') + ':' + sentences.join(' ').replace(/\s+/g, ' ').trim());
      }
    });
    return parts;
  } catch (e) {
    return null;
  }
}

// Today's date as AirNow writes validDate (MM/DD/YY), in the bot's timezone.
function aqiTodayMdy(now) {
  return Utilities.formatDate(now || new Date(), 'America/New_York', 'MM/dd/yy');
}

// AQI: category (not the raw number, which churns hourly) per watched
// reporting area — the Worker's alert threshold is a category boundary, so
// category changes are the only ones that matter.
//
// Restricted to today's records because that is all the Worker ever reads
// (worstAqiToday in aqi.js scores today's observed and forecast rows for the
// guild's area and ignores the rest). AirNow returns six more days of
// forecast per area and revises them throughout the day; fingerprinting those
// pinged /context-hook to drop the AQI cache for rows nothing would look at.
function aqiFingerprintParts(mdBody, dcBody, todayMdy) {
  if (!mdBody || !dcBody) return null;
  var parts = [];
  try {
    [mdBody, dcBody].forEach(function (body) {
      var records = JSON.parse(body);
      (Array.isArray(records) ? records : []).forEach(function (r) {
        if (!r || AQI_WATCHED_AREAS.indexOf(r.reportingArea) === -1) return;
        if (r.validDate !== todayMdy) return;
        parts.push(r.reportingArea + '|' + (r.dataType || '') + '|' + (r.category || '') + '|' + (r.isActionDay === true ? 'action' : ''));
      });
    });
  } catch (e) {
    return null;
  }
  return parts.sort();
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
  var text = statusFingerprintText(content);
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

// Visible text of the status block, minus the date it always carries
// ("Important Status Message July 25, 2026 Normal Operations ..."). That date
// rolls at midnight whether or not the status did, so keeping it meant one
// guaranteed /status-hook ping a day that ran a full check pass and posted
// nothing. Any real change — a closing, a delay, an early dismissal — rewrites
// the message text, which is still fingerprinted in full.
function statusFingerprintText(content) {
  return String(content || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function md5Hex(text) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text);
  return digest.map(function (b) { return ((b + 256) % 256).toString(16); }).join('');
}

// NWS collector. Each zone is independent: a bad fetch for one zone never
// blocks the others, and each zone's fingerprint only advances once the Worker
// confirms it stored that zone's alerts, so a Worker outage means a retry on
// the next run rather than a lost alert.
function collectNwsAlerts(props, batch) {
  NWS_ZONES.forEach(function (zone) {
    try {
      var body = fetchZoneBody(zone);
      if (body === null) return; // fetch failed; try again next run

      var features = (JSON.parse(body) || {}).features || [];
      var fingerprint = changedFingerprint(props, 'fp_' + zone, alertFingerprintParts(features));
      if (!fingerprint) return;

      var zones = {};
      zones[zone] = body;
      stageUnit(batch, 'fp_' + zone, fingerprint, ['weather:' + zone], null, zones);
    } catch (e) {
      console.error('Zone ' + zone + ' check failed: ' + e);
    }
  });
}

// A zone's raw active-alerts feed. Returns null when it can't be read.
function fetchZoneBody(zone) {
  var resp = UrlFetchApp.fetch('https://api.weather.gov/alerts/active/zone/' + zone, {
    headers: { 'User-Agent': NWS_USER_AGENT, 'Accept': 'application/geo+json' },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    console.error('NWS fetch for ' + zone + ' returned ' + resp.getResponseCode());
    return null;
  }
  return resp.getContentText();
}

// Reduces a zone's raw features to exactly what the Worker keeps — this is a
// mirror of summarizeWeatherAlerts in hcpss-worker/src/weather.js: real
// alerts only ('Actual' status), no cancellations, one entry per event name.
//
// Fingerprinting the raw feed (alert id + sent time) was a steady KV drain:
// NWS broadcasts a "Test Message" KEEPALIVE on some zones — MDC031 gets one
// every 10 minutes, around the clock — each with a fresh id and sent time.
// Every one of those read as a zone change and pinged /nws-hook, ~144 times
// a day, and the Worker threw the message away on arrival (status 'Test')
// after spending a KV delete on its alert cache. Keying on the fields the bot
// actually acts on (event drives the notice, severity drives storm and
// power-threat gating, end time drives the "until" line and the
// tomorrow-morning outlook) also means a routine reissue of an unchanged
// alert no longer pings. A reworded headline alone won't push either — the
// hourly cache TTL is the safety net for that.
function alertFingerprintParts(features) {
  var seen = {};
  var parts = [];
  (Array.isArray(features) ? features : []).forEach(function (f) {
    var p = (f && f.properties) || {};
    if (!p.event) return;
    if (p.status && p.status !== 'Actual') return;
    if (p.messageType === 'Cancel') return;
    if (seen[p.event]) return;
    seen[p.event] = true;
    parts.push(p.event + '|' + (p.severity || 'Unknown') + '|' + (p.ends || p.expires || ''));
  });
  return parts.sort();
}

// Run once manually to install the 5-minute trigger (replaces any existing
// triggers for this script so re-running never stacks duplicates).
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runWatchers').timeBased().everyMinutes(5).create();
  console.log('Trigger installed: runWatchers every 5 minutes.');
}

// Optional: run manually to verify the Worker URL + secret are right. Sends an
// empty push, which changes nothing. Expect {"ok":true,"written":[],"skipped":[]}.
function testPing() {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = props.getProperty('WORKER_URL');
  var secret = props.getProperty('NWS_HOOK_SECRET');
  if (!workerUrl || !secret) {
    console.error('Set WORKER_URL and NWS_HOOK_SECRET in Script Properties first.');
    return;
  }
  var resp = UrlFetchApp.fetch(workerUrl.replace(/\/+$/, '') + '/push-data', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: '{}',
    muteHttpExceptions: true
  });
  console.log('Worker replied ' + resp.getResponseCode() + ': ' + resp.getContentText());
}

// Clears every stored fingerprint. The next run re-baselines instead of
// pushing, so this is the safe way to recover if the Script Properties and the
// Worker's caches ever disagree — it costs one quiet run, not a burst of
// pushes.
function resetFingerprints() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var cleared = 0;
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('fp_') === 0) {
      props.deleteProperty(key);
      cleared++;
    }
  });
  console.log('Cleared ' + cleared + ' fingerprint(s); next run re-baselines without pushing.');
}

// --- Reading the Worker's logs from here ---
//
// Everything the Worker does is written to Cloudflare's own log store with an
// ACT| prefix (see hcpss-worker/src/actionlog.js). Those logs cost nothing —
// unlike KV — and they are queryable over the Cloudflare API, which means this
// function talks to Cloudflare directly and never touches the Worker. That is
// the point: the Worker posts none of this to Discord (the control panel is
// the only in-server log, and it stops updating when the Worker is the thing
// that's broken), and this still works.
//
// One-time setup:
//   1. Cloudflare dashboard → My Profile → API Tokens → Create Token →
//      Custom token with these permissions:
//        Account → Workers Observability → Read
//        Account → Account Analytics → Read
//   2. Script Properties → CF_API_TOKEN = <that token>
//                          CF_ACCOUNT_ID = <your account id>
//
// Usage: showLogs() for the last 2 hours, showLogs(12) for the last 12, or
// showErrors() for failures only. Output goes to the Apps Script execution
// log (View → Executions, or the console pane in the editor).
function showLogs(hours, onlyErrors) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('CF_API_TOKEN');
  var account = props.getProperty('CF_ACCOUNT_ID');
  if (!token || !account) {
    console.error('Set CF_API_TOKEN and CF_ACCOUNT_ID in Script Properties — see the comment above showLogs().');
    return;
  }

  var to = Date.now();
  var from = to - (Number(hours) > 0 ? Number(hours) : 2) * 3600 * 1000;

  var filters = [
    { key: '$metadata.service', operation: 'eq', type: 'string', value: 'hcpss-worker' }
  ];

  var resp = UrlFetchApp.fetch(
    'https://api.cloudflare.com/client/v4/accounts/' + account + '/workers/observability/telemetry/query',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({
        queryId: 'school-status-bot-gas',
        timeframe: { from: from, to: to },
        parameters: { datasets: ['cloudflare-workers'], filters: filters, limit: 200 },
        view: 'events',
        limit: 200
      }),
      muteHttpExceptions: true
    }
  );

  if (resp.getResponseCode() !== 200) {
    console.error('Cloudflare logs query failed: ' + resp.getResponseCode() + ' ' + resp.getContentText());
    return;
  }

  var parsed;
  try {
    parsed = JSON.parse(resp.getContentText());
  } catch (e) {
    console.error('Cloudflare logs response was not JSON.');
    return;
  }
  if (!parsed.success) {
    console.error('Cloudflare logs query rejected: ' + JSON.stringify(parsed.errors || []));
    return;
  }

  var events = ((parsed.result || {}).events || {}).events || [];
  if (!events.length) {
    console.log('No Worker log events in the last ' + (Number(hours) > 0 ? hours : 2) + ' hour(s).');
    return;
  }

  // Oldest first reads like a story; the API returns newest first.
  var lines = [];
  events.forEach(function (ev) {
    var message = logEventMessage(ev);
    if (!message) return;
    if (onlyErrors && message.indexOf('|error|') === -1 && String((ev.$metadata || {}).level || '') !== 'error') return;
    lines.push(Utilities.formatDate(new Date(ev.timestamp), 'America/New_York', 'MM-dd HH:mm:ss') + '  ' + message);
  });

  if (!lines.length) {
    console.log(onlyErrors ? 'No errors logged in that window.' : 'Events returned but none carried a message.');
    return;
  }

  lines.reverse();
  // Apps Script truncates very long single log entries, so print in blocks.
  for (var i = 0; i < lines.length; i += 40) {
    console.log(lines.slice(i, i + 40).join('\n'));
  }
  console.log('— ' + lines.length + ' line(s) from the last ' + (Number(hours) > 0 ? hours : 2) + ' hour(s).');
}

// Failures only.
function showErrors(hours) {
  showLogs(hours || 24, true);
}

// Pulls the human-readable text out of one Workers Logs event. The shape
// varies by how the line was produced (console.log vs. an uncaught throw), so
// this checks the known locations and falls back to the raw event.
function logEventMessage(ev) {
  if (!ev) return '';
  if (typeof ev.message === 'string' && ev.message) return ev.message;

  var src = ev.source || {};
  if (typeof src.message === 'string' && src.message) return src.message;

  // console.log("a", "b") arrives as an argument array.
  var args = src.arguments || ev.arguments;
  if (Array.isArray(args) && args.length) {
    return args.map(function (a) {
      return typeof a === 'string' ? a : JSON.stringify(a);
    }).join(' ');
  }

  var meta = ev.$metadata || {};
  if (typeof meta.message === 'string' && meta.message) return meta.message;
  if (typeof meta.error === 'string' && meta.error) return 'ERROR ' + meta.error;

  return '';
}
