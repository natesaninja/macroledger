# MacroLedger photo estimate Worker (free + limits)

Shared proxy so **other people** can use photo → calories/macros without their own API keys.

## What it does

- Accepts a compressed food photo
- Calls **Gemini** (free tier) with a nutrition JSON prompt
- Enforces **5 scans per IP / day** and a **global daily cap** (default 400)
- Returns items: name, portion, calories, protein, carbs, fat, fiber, confidence

## One-time setup (free)

### 1. Gemini API key

1. Open [Google AI Studio](https://aistudio.google.com/apikey)
2. Create an API key (free tier is fine)
3. Copy the key

### 2. Deploy Worker

```bash
cd worker/photo-estimate
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
# paste key when prompted
npx wrangler deploy
```

Wrangler prints a URL like:

`https://macroledger-photo-estimate.<your-subdomain>.workers.dev`

### 3. Point MacroLedger at it

In the app: **Goals → Photo food log → Proxy URL**

Paste:

`https://macroledger-photo-estimate.<your-subdomain>.workers.dev`

Save goals. Everyone using your deployed app (or that URL in Settings) shares the free pool.

## Limits (defaults)

| Limit | Default |
|-------|---------|
| Per IP / day | 5 |
| Global / day | 400 |
| Model | `gemini-2.5-flash-lite` |

Change in `wrangler.toml` `[vars]` or Cloudflare dashboard.

When limits hit, the app shows a friendly message; barcode / search / voice still work.

## Local test

```bash
npx wrangler dev
curl -X POST http://127.0.0.1:8787/estimate -H "Content-Type: application/json" -d "{\"imageBase64\":\"...\",\"mimeType\":\"image/jpeg\"}"
```

## Cost

- Cloudflare Workers free: 100k requests/day  
- Gemini free tier: daily model caps (varies; Flash-Lite is the most generous)  
- No user billing if you stay under free quotas
