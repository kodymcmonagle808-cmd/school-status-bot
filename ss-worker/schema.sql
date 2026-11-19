-- Cloudflare D1 Database Schema for School Status Bot
-- Database: school-status-db
--
-- Apply locally:
--   npx wrangler d1 execute school-status-db --local --file=./schema.sql
--
-- Apply to production:
--   npx wrangler d1 execute school-status-db --remote --file=./schema.sql

-- 1. Key-Value compatibility store (replaces Cloudflare KV with 100x write capacity)
CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kv_store_expires ON kv_store(expires_at);

-- 2. Operating Status Change History
CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  district_id TEXT NOT NULL DEFAULT 'hcpss',
  status_key TEXT,
  status_text TEXT,
  status_date TEXT,
  timestamp INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_status_history_district_ts ON status_history(district_id, timestamp DESC);

-- 3. Weather Alerts & Severe Event History
CREATE TABLE IF NOT EXISTS weather_events (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  severity TEXT,
  headline TEXT,
  description TEXT,
  zone TEXT,
  county TEXT,
  effective INTEGER,
  expires INTEGER,
  timestamp INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_weather_events_ts ON weather_events(timestamp DESC);

-- 4. School Announcement Emails Archive
CREATE TABLE IF NOT EXISTS emails (
  id TEXT,
  guild_id TEXT,
  subject TEXT,
  body TEXT,
  channel_id TEXT,
  message_id TEXT,
  ts INTEGER,
  url TEXT,
  image_url TEXT,
  ai_summary TEXT,
  PRIMARY KEY (id, guild_id)
);
CREATE INDEX IF NOT EXISTS idx_emails_guild_ts ON emails(guild_id, ts DESC);
