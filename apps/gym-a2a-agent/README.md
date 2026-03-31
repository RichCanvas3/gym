## gym-a2a-agent

Per-user A2A ingress (wildcard subdomains) that forwards to your LangGraph deployment.

### Required Worker env

- **vars** (in `wrangler.jsonc`)
  - `HANDLE_BASE_DOMAIN`: the wildcard base domain (example: `a2a.example.com`)
  - `DEFAULT_TZ`: fallback timezone (example: `America/Denver`)
  - `LANGGRAPH_ASSISTANT_ID`: LangGraph assistant id (example: `gym`)
- **secrets** (set via `wrangler secret put`)
  - `A2A_ADMIN_KEY`: allows the web app to upsert handle→account mappings at `POST /api/a2a/handle`
  - `A2A_WEB_KEY`: allows the web app to call `POST /api/a2a` without wallet signatures (header `x-web-key`)
  - `LANGGRAPH_DEPLOYMENT_URL`: base URL for LangGraph (no trailing slash)
  - `LANGSMITH_API_KEY`: LangSmith key for LangGraph calls

### Deploy

```bash
cd apps/gym-a2a-agent
pnpm install

wrangler secret put A2A_ADMIN_KEY
wrangler secret put A2A_WEB_KEY
wrangler secret put LANGGRAPH_DEPLOYMENT_URL
wrangler secret put LANGSMITH_API_KEY

pnpm deploy
```

### Notes

- You need a real wildcard domain so `https://<handle>.<HANDLE_BASE_DOMAIN>/api/a2a` resolves normally (no Host-header spoofing on `workers.dev`).

