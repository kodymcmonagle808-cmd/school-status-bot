export function getEasternTimeStr(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(date);
  const hourVal = parts.find(p => p.type === 'hour').value;
  const minuteVal = parts.find(p => p.type === 'minute').value;
  const hr = parseInt(hourVal, 10) % 24;
  const min = parseInt(minuteVal, 10);
  return `${hr}:${min.toString().padStart(2, '0')}`;
}

export function matchesScheduleTime(currentEtStr, scheduledTimeStr) {
  const [currH, currM] = currentEtStr.split(':').map(Number);
  const [schedH, schedM] = scheduledTimeStr.split(':').map(Number);

  const currMin = currH * 60 + currM;
  const schedMin = schedH * 60 + schedM;

  let diff = currMin - schedMin;
  if (diff < -1200) {
    diff += 1440;
  }

  // Never fire early; allow up to 5 minutes late in case a cron tick is delayed.
  // Duplicate firings within the window are skipped via the last_sched_slot dedupe key.
  return diff >= 0 && diff <= 5;
}

export function clockEmojiForTime(timeStr) {
  const [h] = String(timeStr).split(':').map(Number);
  const h12 = ((isNaN(h) ? 12 : h) % 12) || 12;
  return String.fromCodePoint(0x1F550 + h12 - 1);
}

export function formatScheduleTimeLabel(timeStr) {
  const [h, m] = String(timeStr).split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return timeStr;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

export function formatCheckedAt(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(date);
}

export function formatStatusDate(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

export function formatYmdNY(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
