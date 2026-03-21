-- D1 schema: Strava sync
PRAGMA foreign_keys = ON;

-- Stores synced activities as workouts
CREATE TABLE IF NOT EXISTS workouts (
  workout_id TEXT PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS idx_workouts_activity_type ON workouts(activity_type);

CREATE TABLE IF NOT EXISTS strava_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_sync_at_iso TEXT NOT NULL
);
INSERT OR IGNORE INTO strava_sync_state (id, last_sync_at_iso) VALUES (1, '1970-01-01T00:00:00.000Z');
