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

// Storm mode: extra checks every 15 minutes during the 4:30-7:30 AM ET window,
// when HCPSS typically announces weather closings and delays.
export const STORM_WINDOW_START_MIN = 4 * 60 + 30;
export const STORM_WINDOW_END_MIN = 7 * 60 + 30;
export const STORM_INTERVAL_MIN = 15;

// Midday watch: same 15-minute cadence during the 10 AM-2 PM ET window, when
// early dismissals get announced as weather deteriorates during the school day.
export const MIDDAY_WINDOW_START_MIN = 10 * 60;
export const MIDDAY_WINDOW_END_MIN = 14 * 60;

export function isInStormWindow(etStr) {
  const [h, m] = String(etStr).split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return false;
  const mins = h * 60 + m;
  return mins >= STORM_WINDOW_START_MIN && mins <= STORM_WINDOW_END_MIN;
}

// Returns the quarter-hour slot label (e.g. "5:15") when the given ET time is
// on — or up to 2 minutes after — a 15-minute tick inside the window, else null.
// The grace period covers delayed cron ticks; the slot label doubles as the
// dedupe key so a tick never fires twice.
function tickSlotInWindow(etStr, startMin, endMin) {
  const [h, m] = String(etStr).split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const mins = h * 60 + m;
  const rem = mins % STORM_INTERVAL_MIN;
  if (rem > 2) return null;
  const slotMin = mins - rem;
  if (slotMin < startMin || slotMin > endMin) return null;
  return `${Math.floor(slotMin / 60)}:${String(slotMin % 60).padStart(2, '0')}`;
}

export function stormTickSlot(etStr) {
  return tickSlotInWindow(etStr, STORM_WINDOW_START_MIN, STORM_WINDOW_END_MIN);
}

export function middayTickSlot(etStr) {
  return tickSlotInWindow(etStr, MIDDAY_WINDOW_START_MIN, MIDDAY_WINDOW_END_MIN);
}
