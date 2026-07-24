# MacroLedger

**Live:** https://natesaninja.github.io/macroledger/

iPhone: Safari → that URL → Share → Add to Home Screen.

If you still see CalorieTrack, you are on the OLD app. Delete that home screen icon and install from this URL only.

## Photo meal log (free + limits)

Snap a plate → AI estimates calories & macros → review → save. No typing required.

1. Deploy the free proxy: see [`worker/photo-estimate/README.md`](worker/photo-estimate/README.md)
2. In the app: **Goals → Photo food log → Proxy URL** → paste your Worker URL → Save
3. Diary → **Photo meal** → take a picture

Limits (defaults): **5 free scans per device/day**, shared global daily cap on the Worker. Barcode, search, and voice still work when the free photo quota is used up.

Optional solo setup: paste a personal Gemini API key in Goals instead of a proxy (key stays on that phone only — not for sharing with others).
