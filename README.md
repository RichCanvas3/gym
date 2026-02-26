# Climb Gym Copilot

Monorepo with:

- Next.js web UI: `apps/web`
- Hosted agent (LangGraph for LangSmith Deployments): `langgraph.json` + `apps/api/graph.py`
- Local JS agent (optional): `apps/web/app/api/chat/route.ts`

## Local dev (web + local JS agent)

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000/chat`.

## Deploy to LangSmith Deployments (push-to-deploy)

1) Push this repo to GitHub.

2) In LangSmith:
- Go to **Deployments** → **New Deployment**
- Select your repo + branch
- Config path: `langgraph.json`
- Set env vars:
  - `OPENAI_API_KEY`
  - (optional) `OPENAI_MODEL=gpt-5.2`
  - (optional) `OPENAI_EMBEDDINGS_MODEL=text-embedding-3-large`

3) In your Next.js host (Vercel/etc), set env vars:
- `NEXT_PUBLIC_USE_LANGGRAPH=1`
- `LANGGRAPH_DEPLOYMENT_URL=<deployment base url>`
- `LANGGRAPH_ASSISTANT_ID=gym`
- `LANGSMITH_API_KEY=<server-side secret>`

Web calls `POST /api/agent/run` (server-side proxy) → `<DEPLOYMENT_URL>/runs/wait`.

