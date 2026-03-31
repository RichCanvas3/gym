This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## A2A-backed chat (prod)

The chat route `POST /api/agent/run` forwards requests through `gym-a2a-agent` (A2A) instead of calling LangGraph directly.

Server-side env vars (Vercel):

- `A2A_AGENT_URL`: base worker URL (no handle subdomain), e.g. `https://gym-a2a-agent.<acct>.workers.dev`
- `A2A_HANDLE_BASE_DOMAIN`: wildcard base domain, e.g. `a2a.example.com`
- `A2A_ADMIN_KEY`: must match worker `A2A_ADMIN_KEY` (used to upsert handle mappings)
- `A2A_WEB_KEY`: must match worker `A2A_WEB_KEY` (used as header `x-web-key`)

Optional (UI only):

- `NEXT_PUBLIC_A2A_HANDLE_BASE_DOMAIN`: used by `/a2a` page to show the endpoint URL.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
