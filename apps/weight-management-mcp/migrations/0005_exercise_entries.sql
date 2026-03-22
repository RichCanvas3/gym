-- Exercise/workout calorie burn entries (e.g. from Strava)

CREATE TABLE IF NOT EXISTS wm_exercise_entries (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  workout_id TEXT NOT NULL,
  activity_type TEXT,
  duration_seconds INTEGER,
  distance_meters REAL,
  active_energy_kcal REAL,
  raw_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uidx_wm_exercise_scope_source_workout ON wm_exercise_entries(scope_id, source, workout_id);
CREATE INDEX IF NOT EXISTS idx_wm_exercise_scope_time ON wm_exercise_entries(scope_id, at_ms DESC);

