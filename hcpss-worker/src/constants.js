// Shared constants for the HCPSS status monitor worker.

export const EMBED_LIMIT = 4096;
export const EMBED_SAFE = 3900;
export const MAX_EMBEDS = 10;
export const EPHEMERAL_FLAG = 64;

export const MANUAL_TRIGGER_HEADER = 'x-manual-trigger-token';

export const POST_STATUS_COMMAND = 'post-status';
export const OVERRIDE_COMMAND = 'override';
export const ANNOUNCE_COMMAND = 'announce';

export const DANK_MEMER_TERMS = `CHS Network. Dank Memer Terms & Conditions

By using Dank Memer in this server you agree to the following:

1. Entertainment Only
Dank Memer currency, items and pets are for fun. They don't have real-world value. Can't be bought, sold or traded for real money or things. If you try to do you will get banned.

2. No Exploits or Bugs
Don't try to cheat by using bugs, glitches or bot errors to get currency or items. If you find a bug tell a moderator of using it. If you get caught cheating your earnings will be. You might get muted or banned.

3. No Begging or Spamming
Don't beg for currency or spam commands. Use the designated bot channels only. If you do this a lot you might get in trouble.

4. Alt Accounts
Using accounts to get more currency avoid cooldowns or cheat in giveaways or trading is not allowed. If you get caught both your accounts will get banned.

5. Trading & Gambling Features
Dank Memer has fun games like blackjack and slots. These are not gambling and are, for entertainment only. Please use them responsibly. If moderators think you're using them much they might talk to you.

6. Fair Play
Don't scam others during trades, giveaways or heists. Once you make a trade it can't be undone. Be careful when you trade.

7. Server Rules Still Apply
The normal CHS Network server rules still apply when using Dank Memer. Using the bot doesn't mean you can break the rules.

8. Age Requirement
You must be least 13 years old to use Discord and Dank Memer. If you lie about your age to use the bot you might get banned.

9. Moderator Discretion
Moderators can reset, adjust or remove currency or items if they see you're cheating or abusing the system. They can also update these terms at any time.`;

export const DEFAULT_STAFF_ROLE_ID = '1521682363942436896';
export const DEFAULT_LOG_CHANNEL_ID = '1524911607942221965';
export const DEFAULT_CHECK_SCHEDULE = ['5:20', '7:20', '10:00', '20:00'];

// The five operating statuses HCPSS publishes (used for overrides and setup).
export const STATUS_LABELS = {
  normal_operations: 'Normal Operations',
  schools_closed: 'Schools Closed',
  schools_and_offices_closed: 'Schools and Offices Closed',
  schools_open_2_hours_late: 'Schools Open 2 Hours Late',
  schools_close_3_hours_early: 'Schools Close 3 Hours Early'
};

// All statuses including the catch-all for unrecognized alerts.
export const ALL_STATUS_LABELS = {
  ...STATUS_LABELS,
  unknown_alert: 'Other/Unknown Alert'
};

export function getDefaultStatusColor(statusKey) {
  switch (statusKey) {
    case 'normal_operations':
      return 3066993; // #2ECC71
    case 'schools_closed':
    case 'schools_and_offices_closed':
    case 'unknown_alert':
      return 16711680; // #FF0000
    case 'schools_open_2_hours_late':
    case 'schools_close_3_hours_early':
      return 8421504; // #808080
    default:
      return 16711680; // Default to #FF0000
  }
}

export function getStatusThumbnail(statusKey) {
  return '';
}

// 2026-2027 HCPSS calendar highlights for annotating "Normal Operations" days
// (and any other status date) with the scheduled event.
export const SCHOOL_CALENDAR_EVENTS = {
  '2026-08-13': 'First day for staff',
  '2026-08-24': 'First day for K-12 students',
  '2026-08-27': 'First day for pre-K/RECC students',
  '2026-09-07': 'Schools and offices closed* – Labor Day',
  '2026-09-21': 'Schools and offices closed – Yom Kippur',
  '2026-09-30': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Learning/Workday',
  '2026-10-16': 'Schools closed for students – Staff Professional Learning Day',
  '2026-10-28': 'Schools closed for students – Staff Professional Learning/Workday',
  '2026-11-03': 'Schools and offices closed – Election Day*',
  '2026-11-23': 'Schools close 3 hours early; No half-day Pre-K/RECC – ES/MS Parent/Teacher Conferences, HS Staff Professional Day',
  '2026-11-24': 'Schools close 3 hours early; No half-day Pre-K/RECC – ES/MS Parent/Teacher Conferences',
  '2026-11-25': 'Schools closed for students – Parent/Teacher Conferences',
  '2026-11-26': 'Schools and offices closed* – Thanksgiving Holiday',
  '2026-11-27': 'Schools and offices closed* – Thanksgiving Holiday',
  '2026-12-09': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Learning/Workday',
  '2026-12-24': 'Schools and offices closed* – Winter Break',
  '2026-12-25': 'Schools and offices closed* – Winter Break',
  '2026-12-28': 'Schools closed* – Winter Break',
  '2026-12-29': 'Schools closed* – Winter Break',
  '2026-12-30': 'Schools closed* – Winter Break',
  '2026-12-31': 'Schools closed* – Winter Break',
  '2027-01-01': 'Schools and offices closed* – Winter Break',
  '2027-01-18': 'Schools and offices closed* – Martin Luther King Jr. Day',
  '2027-01-19': 'Schools closed for students –Staff Professional Workday',
  '2027-02-03': 'Schools closed for students – Staff Professional Learning Day',
  '2027-02-11': 'Elementary schools close 3 hours early; No half-day Pre-K/RECC – ES Parent/Teacher Conferences',
  '2027-02-12': 'Elementary schools close 3 hours early; No half-day Pre-K/RECC – ES Parent/Teacher Conferences',
  '2027-02-15': 'Schools and offices closed* – Presidents Day',
  '2027-03-09': 'Schools closed for students – Eid al Fitr; Staff Professional Learning/Workday',
  '2027-03-22': 'Schools closed* – Spring Break',
  '2027-03-23': 'Schools closed* – Spring Break',
  '2027-03-24': 'Schools closed* – Spring Break',
  '2027-03-25': 'Schools closed* – Spring Break',
  '2027-03-26': 'Schools and offices closed* – Spring Break',
  '2027-03-29': 'Schools and offices closed* – Spring Break',
  '2027-04-08': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Learning/Workday',
  '2027-05-17': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Learning/Workday',
  '2027-05-31': 'Schools and offices closed* – Memorial Day',
  '2027-06-02': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Learning/Workday',
  '2027-06-07': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Workday; If inclement weather days are used, may become a full day',
  '2027-06-08': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Workday – Last Scheduled Day; If inclement weather days are used, may become a full day',
  '2027-06-09': 'May be used as inclement weather days',
  '2027-06-10': 'May be used as inclement weather days',
  '2027-06-11': 'May be used as inclement weather days',
  '2027-06-14': 'May be used as inclement weather days',
  '2027-06-15': 'May be used as inclement weather days',
  '2027-06-16': 'May be used as inclement weather days',
  '2027-06-18': 'Schools and offices closed – Juneteenth (observed)',
  '2027-07-05': 'Schools and offices closed – Independence Day (observed)'
};
