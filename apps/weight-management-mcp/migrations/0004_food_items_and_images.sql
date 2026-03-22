-- Add image URLs and normalized food items for trends

ALTER TABLE wm_food_entries ADD COLUMN image_url TEXT;
CREATE INDEX IF NOT EXISTS idx_wm_food_scope_time_meal ON wm_food_entries(scope_id, at_ms DESC, meal);

CREATE TABLE IF NOT EXISTS wm_food_items (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  food_entry_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  meal TEXT,
  name TEXT NOT NULL,
  portion_g REAL,
  calories REAL,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  fiber_g REAL,
  source TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wm_food_items_scope_time ON wm_food_items(scope_id, at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_wm_food_items_scope_meal_name ON wm_food_items(scope_id, meal, name);

