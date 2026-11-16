// Google Apps Script: Standalone HCPSS Announcement Email Watcher for school-status-bot.
//
// Monitors this Gmail account for incoming announcement emails from HCPSS / Centennial
// and forwards them to the bot Worker's /email-hook endpoint on a 5-minute trigger.
//
// This script ONLY handles emails — it does not fetch weather, outages, roads, or status pages.
//
// Setup (one time, ~2 minutes):
//   1. Go to https://script.google.com → New project, name it "HCPSS Email Watcher".
//   2. Replace the default Code.gs content with this entire file.
//   3. Project Settings (gear icon ⚙️) → Script Properties → add:
//        WORKER_URL      = https://ss-worker.kodymcmonagle808.workers.dev
//        NWS_HOOK_SECRET = chs_hook_82a93f1d4b
//      Optional:
//        EMAIL_QUERY     = from:no-reply@hcpss.org (Centennial OR CHS)
//   4. In the editor, select setupTriggers in the function dropdown and click Run.
//      Grant the permissions requested (Gmail read + triggers + external requests).
//   5. Done! The script checks for new emails every 5 minutes in the background.

var EMAIL_LABEL = 'school-status-bot-forwarded';
var DEFAULT_EMAIL_QUERY = 'from:no-reply@hcpss.org';

// Main scheduled function: called every 5 minutes by the time-based trigger.
function runWatchers() {
  checkHcpssEmails();
}

// Forwards HCPSS announcement emails from this Google account's inbox to the
// Worker's /email-hook, which posts them to the configured Discord channel.
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

// Installs the 5-minute recurring trigger. Run once when setting up.
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runWatchers').timeBased().everyMinutes(5).create();
  console.log('Trigger installed: runWatchers (emails only) every 5 minutes.');
}

// Test function: verifies that the Worker URL and secret are working properly.
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
