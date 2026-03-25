-- D1 schema: gym-googlecalendar oauth + tokens (per canonical account address)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS google_oauth_states (
  state TEXT PRIMARY KEY,
  account_address TEXT NOT NULL,
  telegram_user_id TEXT,
  created_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_google_oauth_states_created ON google_oauth_states(created_at_iso);

CREATE TABLE IF NOT EXISTS google_calendar_connections (
  account_address TEXT PRIMARY KEY,
  telegram_user_id TEXT,
  google_sub TEXT,
  google_email TEXT,
  refresh_token_enc TEXT NOT NULL,
  scope TEXT,
  token_type TEXT,
  access_token TEXT,
  expiry_date_ms INTEGER,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_google_calendar_connections_tg ON google_calendar_connections(telegram_user_id);

-- Optional cached events (synced by tool, not required for live API calls).
CREATE TABLE IF NOT EXISTS google_calendar_events (
  account_address TEXT NOT NULL,
  telegram_user_id TEXT,
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  start_iso TEXT,
  end_iso TEXT,
  start_ms INTEGER,
  end_ms INTEGER,
  summary TEXT,
  description TEXT,
  status TEXT,
  updated_at_iso TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (account_address, calendar_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_google_calendar_events_start ON google_calendar_events(account_address, start_ms);
CREATE INDEX IF NOT EXISTS idx_google_calendar_events_tg_start ON google_calendar_events(telegram_user_id, start_ms);

