-- D1 schema: Strava sync
PRAGMA foreign_keys = ON;

-- Stores synced activities as workouts
CREATE TABLE IF NOT EXISTS workouts (
  workout_id TEXT PRIMARY KEY,
  scope_id TEXT,
  source TEXT NOT NULL,
  device TEXT,
  event_type TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  started_at_iso TEXT NOT NULL,
  ended_at_iso TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  distance_meters REAL,
  active_energy_kcal REAL,
  metadata_json TEXT,
  created_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workouts_ended_at ON workouts(ended_at_iso DESC);
CREATE INDEX IF NOT EXISTS idx_workouts_scope_ended_at ON workouts(scope_id, ended_at_iso DESC);
CREATE INDEX IF NOT EXISTS idx_workouts_activity_type ON workouts(activity_type);

CREATE TABLE IF NOT EXISTS strava_sync_state_v2 (
  scope_id TEXT PRIMARY KEY,
  last_sync_at_iso TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strava_tokens (
  telegram_user_id TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  scope TEXT,
  athlete_json TEXT,
  updated_at_iso TEXT NOT NULL
);

-- Preferred: key connections by Privy canonical account address (accountAddress).
CREATE TABLE IF NOT EXISTS strava_tokens_v2 (
  account_address TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  scope TEXT,
  athlete_json TEXT,
  updated_at_iso TEXT NOT NULL
);
