-- Drop deprecated weights table (we store weight in wm_profiles.profile_json only).

DROP INDEX IF EXISTS idx_wm_weights_scope_time;
DROP TABLE IF EXISTS wm_weights;

