# MacroLedger

**Live:** https://natesaninja.github.io/macroledger/

iPhone: Safari → that URL → Share → Add to Home Screen.

If you still see CalorieTrack, you are on the OLD app. Delete that home screen icon and install from this URL only.

**Look:** Quiet ledger — warm paper theme, Source Serif + IBM Plex Sans, text actions (v15).

## Iron Ledger bridge

Finish a session in [Iron Ledger](https://natesaninja.github.io/iron-ledger/) → **Open MacroLedger**.  
Macro auto-logs exercise burn, then shows a **protein left today** card with **Log post-workout meal** / **Photo meal**.

**Training week strip** on Diary: Mon–Sun lift days (from Iron) vs protein goal hits (`L` = lift, `P` = protein, `✓` = both).

## Photo meal (ready for everyone)

**No setup for people using the app.** Diary → **Photo meal** → snap a plate → review → Save.

Behind the scenes: free Cloudflare Worker + Workers AI.  
App owner only: deploy [`worker/photo-estimate`](worker/photo-estimate/README.md) once; keep `DEFAULT_PHOTO_PROXY_URL` in `js/photo-log.js` pointed at it.

**Fastest log:** bottom bar **Search · Barcode · Macros**. Diary also has **Recipe** — photo a card or paste ingredients; we estimate the batch and you log your share.

Barcode looks up Open Food Facts (UPC and EAN). If the code isn’t in that library, tap **Scan macros on package** — photograph the Nutrition Facts panel and we save it (with the barcode) for next time.

Limits: about **5 free photos per day** per device (plate or label). Voice / text also searches Open Food Facts when online.

**Updates** apply automatically when online. Never delete the Home Screen icon to “update” (iPhone can erase diary data).
