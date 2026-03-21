# Strava sync setup (gym-core-mcp)

Strava workouts are stored in the same **`workouts`** table as Apple HealthKit data (`source='strava'`, `workout_id='strava-<id>'`). MCP tools **core_list_workouts**, **core_get_workout**, **core_latest_workout** return all sources.

## 1. Strava API app

1. Go to [Strava API Settings](https://www.strava.com/settings/api).
2. Note **Client ID** and **Client Secret**.
3. Set **Authorization Callback Domain** to `localhost` (for getting a refresh token).

## 2. Get a refresh token (one-time)

1. Open in a browser (replace `YOUR_CLIENT_ID`):
   ```
   https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost&approval_prompt=force&scope=activity:read_all
   ```
2. Authorize the app. You’ll be redirected to `http://localhost/?code=...` (page may not load; that’s OK).
3. Copy the `code` from the URL. Exchange it for tokens:
   ```bash
   curl -X POST "https://www.strava.com/oauth/token" \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "code=PASTE_CODE_HERE" \
     -d "grant_type=authorization_code"
   ```
4. From the JSON response, copy **`refresh_token`** (not `access_token`).

## 3. Worker secrets

```bash
cd apps/gym-core-mcp
pnpm exec wrangler secret put STRAVA_CLIENT_ID
pnpm exec wrangler secret put STRAVA_CLIENT_SECRET
pnpm exec wrangler secret put STRAVA_REFRESH_TOKEN
```

Paste the values when prompted.

## 4. D1 schema

Ensure **`strava_sync_state`** (and **`workouts`**) exist:

```bash
pnpm exec wrangler d1 execute gym-core --remote --file schema.sql
```

## 5. How sync runs

- **Manual:** `POST` or `GET` **`/internal/sync-strava`** with header **`x-api-key: <MCP_API_KEY>`**. Syncs last 30 days of activities; dedupes by `workout_id`.
- **On MCP requests:** Every MCP request (any tool) triggers a **background** Strava sync **if** the last sync was more than **15 minutes** ago. The response is not delayed; sync runs in `waitUntil`. So when you call **core_list_workouts** or **core_latest_workout**, data is usually fresh without calling `/internal/sync-strava` yourself.

## 6. Optional: cron

To sync on a schedule, add a `scheduled` handler and a cron trigger in `wrangler.jsonc` (e.g. daily), and call `syncStravaToWorkouts(env)` from it.
