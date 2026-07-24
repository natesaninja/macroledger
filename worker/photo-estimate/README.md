# MacroLedger photo estimate Worker

Shared free photo → calories/macros for the app. **End users need no setup, no API keys, and no Goals config.**

## How it works

1. App sends a compressed plate photo to this Worker
2. Worker uses **Cloudflare Workers AI** (built-in) to estimate foods & macros
3. Optional: set `GEMINI_API_KEY` secret as a fallback model
4. Limits: **5 scans per IP / day**, **400 global / day** (defaults)

## Deploy (app owner only)

```bash
cd worker/photo-estimate
npx wrangler login   # once
npx wrangler deploy
```

URL example:

`https://macroledger-photo-estimate.<your-subdomain>.workers.dev`

Put that URL in the app’s `DEFAULT_PHOTO_PROXY_URL` (already set for this project).

Optional Gemini fallback:

```bash
npx wrangler secret put GEMINI_API_KEY
```

## Health check

```bash
curl https://YOUR-WORKER.workers.dev/health
```

Should show `"ready": true` and `"engine": "workers_ai"`.
