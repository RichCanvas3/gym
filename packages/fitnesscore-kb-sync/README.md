# `@fitnesscore/kb-sync`

One-time full rebuild sync: SQLite exports (D1 dumps) → GraphDB.

Supports:

- `apps/strava-mcp` SQLite export (table: `workouts`)
- `apps/weight-management-mcp` SQLite export (tables: `wm_weights`, `wm_food_entries`, `wm_exercise_entries`)

## Usage

```bash
fitnesscore-kb-sync \
  --scope-id "tg:6105195555" \
  --context-base "https://id.fitnesscore.ai/graph/d1" \
  --strava-sqlite /path/to/strava.sqlite \
  --weight-sqlite /path/to/weight.sqlite
```

Env (GraphDB):

- `GRAPHDB_BASE_URL`, `GRAPHDB_REPOSITORY`, `GRAPHDB_USERNAME`, `GRAPHDB_PASSWORD`
- Optional: `GRAPHDB_CF_ACCESS_CLIENT_ID`, `GRAPHDB_CF_ACCESS_CLIENT_SECRET`

