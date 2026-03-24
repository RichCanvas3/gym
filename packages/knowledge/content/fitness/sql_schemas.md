# FitnessCore: SQL schemas (source of truth)

This KB doc mirrors the *production* SQLite/D1 schemas used by this repo’s MCPs so the agent can answer “what fields exist / what does this mean” questions.

## Strava MCP (`apps/strava-mcp/schema.sql`)

### `workouts`

- `workout_id TEXT PRIMARY KEY`
- `scope_id TEXT` (scoped to `tg:<telegramUserId>`)
- `source TEXT NOT NULL`
- `device TEXT`
- `event_type TEXT NOT NULL`
- `activity_type TEXT NOT NULL`
- `started_at_iso TEXT NOT NULL`
- `ended_at_iso TEXT NOT NULL`
- `duration_seconds INTEGER NOT NULL`
- `distance_meters REAL`
- `active_energy_kcal REAL`
- `metadata_json TEXT`
- `created_at_iso TEXT NOT NULL`

### `strava_tokens`

- `telegram_user_id TEXT PRIMARY KEY`
- `refresh_token TEXT NOT NULL`
- `scope TEXT`
- `athlete_json TEXT`
- `updated_at_iso TEXT NOT NULL`

## Weight management MCP (`apps/weight-management-mcp/migrations/*.sql`)

### `wm_weights`

- `id TEXT PRIMARY KEY`
- `scope_id TEXT NOT NULL` (scoped to `tg:<telegramUserId>`)
- `at_ms INTEGER NOT NULL`
- `weight_kg REAL`
- `bodyfat_pct REAL`
- `notes TEXT`
- `source TEXT`
- `telegram_chat_id TEXT`
- `telegram_message_id INTEGER`
- `created_at INTEGER NOT NULL`

### `wm_food_entries`

- `id TEXT PRIMARY KEY`
- `scope_id TEXT NOT NULL`
- `at_ms INTEGER NOT NULL`
- `meal TEXT`
- `text TEXT`
- `calories REAL`
- `protein_g REAL`
- `carbs_g REAL`
- `fat_g REAL`
- `fiber_g REAL`
- `sugar_g REAL`
- `sodium_mg REAL`
- `source TEXT`
- `telegram_chat_id TEXT`
- `telegram_message_id INTEGER`
- `created_at INTEGER NOT NULL`

### `wm_exercise_entries` (from `0005_exercise_entries.sql`)

- `id TEXT PRIMARY KEY`
- `scope_id TEXT NOT NULL`
- `at_ms INTEGER NOT NULL`
- `source TEXT NOT NULL` (e.g. `strava`)
- `workout_id TEXT NOT NULL`
- `activity_type TEXT`
- `duration_seconds INTEGER`
- `distance_meters REAL`
- `active_energy_kcal REAL` (may be estimated/backfilled by weight-mcp)
- `raw_json TEXT`
- `created_at INTEGER NOT NULL`

## Gym core MCP (`apps/gym-core-mcp/schema.sql`)

### `kb_chunks` (persistent embedding cache)

- `chunk_id TEXT PRIMARY KEY`
- `source_id TEXT NOT NULL`
- `text TEXT NOT NULL`
- `embedding_json TEXT NOT NULL`
- `created_at_iso TEXT NOT NULL`
- `updated_at_iso TEXT NOT NULL`

