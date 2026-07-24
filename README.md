# MacroLedger

**Live:** https://natesaninja.github.io/macroledger/

iPhone: Safari → that URL → Share → Add to Home Screen.

If you still see CalorieTrack, you are on the OLD app. Delete that home screen icon and install from this URL only.

**Look:** Quiet ledger — warm paper theme, Source Serif + IBM Plex Sans, text actions (v15).

## Photo meal (ready for everyone)

**No setup for people using the app.** Diary → **Photo meal** → snap a plate → review → Save.

Behind the scenes: free Cloudflare Worker + Workers AI.  
App owner only: deploy [`worker/photo-estimate`](worker/photo-estimate/README.md) once; keep `DEFAULT_PHOTO_PROXY_URL` in `js/photo-log.js` pointed at it.

Limits: about **5 free photos per day** per device. Barcode / search / voice always work as backup.

**Updates** apply automatically when online. Never delete the Home Screen icon to “update” (iPhone can erase diary data).
