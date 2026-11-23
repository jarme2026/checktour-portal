[README.md](https://github.com/user-attachments/files/35287209/README.md)
# checktour-portal (unified)

A single Worker that serves the portal and all 3 checklists:

| Path | Project |
|---|---|
| `/` | Portal (shortcuts + ETA) |
| `/up/` | Check List Tour — Upholstery (formerly checktourup) |
| `/bo/` | Check List Tour — Board (formerly checktourbo) |
| `/dux/` | Check List — DUX (formerly dux-scan) |

Admin access works the same as before: add `?admin=1` to the URL (e.g. `/?admin=1`, `/up/?admin=1`).
In admin mode, the portal shortcuts open each checklist with `?admin=1` already applied.

## Structure
```
wrangler.jsonc         config (same RESEND_API_KEY / REPORT_RECIPIENTS as the old projects)
src/index.js           Worker + ChecklistState (3 instances: up/bo/dux) + PortalState (ETA)
dist/index.html        portal
dist/up/index.html     Upholstery
dist/bo/index.html     Board
dist/dux/index.html    DUX
dist/manifest.json     app install info (normal users)
dist/manifest-admin.json  app install info (admin, opens ?admin=1)
dist/sw.js             service worker (install + notifications)
dist/icons/            ABC living logo / app icons
```

## Deploy
1. Push this folder to a new GitHub repository.
2. Cloudflare → Workers & Pages → Create → Import a repository → select the repo → Deploy.
   The `resend-api-key` secret in the Secrets Store is already used by the old projects, so it works as-is.
3. Open `/?admin=1`, go into each project and upload its sheet again (the old data stays in the old Workers).
4. Once everything is working, delete the old Workers (checktourup, checktourbo, dux-scan).

## Editing the ETA
Open `/?admin=1`, pick a date for each project and click **Save ETA**.
**Clear** resets it to `**/**/****`. Everyone sees the new ETA immediately.

## ETA / received
Each portal card shows `<Project> ETA dd/mm/yyyy` until that list is fully checked
(every item done or noted). It then shows `<Project> received dd/mm/yyyy` with the date it was completed.
It goes back to the ETA when a new sheet is uploaded, progress is cleared, or an item is unchecked.

## Admin progress (desktop only)
On `/?admin=1` opened on a computer, each card shows a progress bar with `done/total`
(rows checked or noted out of all rows). It refreshes every 1 minute while a list is being checked (started, not finished),
and every 1 hour otherwise, only while the tab is open.
When the tab is reopened (or comes back to the foreground) it refreshes immediately.
Hidden on mobile and in the normal (non-admin) view.

## Phone app (install) — "ABC living"
The portal can be installed on the phone home screen (logo in `dist/icons/`).
- **Android (Chrome/Edge):** open the site and tap **⬇ Install app** (or browser menu → Install app).
- **iPhone/iPad (Safari):** tap **Share** → **Add to Home Screen**.
- The normal link installs **ABC living**; the `?admin=1` link installs a separate **ABC Admin** app that always opens in admin mode.

## Notifications (new sheet)
- In the app, tap **🔔 Enable notifications** and allow. Works for normal users and admin.
- Every time a sheet is uploaded in Upholstery, Board or DUX, all enabled phones get
  "<Project> - dd/mm/yyyy" (the ETA date saved in the portal for that list; just "<Project>" if no ETA is set). Tapping it opens that checklist (admin devices open it with `?admin=1`).
- iPhone: only inside the installed app (Add to Home Screen first), iOS 16.4 or newer.
- No keys to configure: the Worker creates its own push keys on first use (stored in the Durable Object).
- To stop: tap **Turn off** next to "Notifications on", or block notifications in the phone settings.

## Changes compared to the old projects
- API calls now use the project prefix (`/up/api/...`, `/bo/api/...`, `/dux/api/...`).
- Each checklist has an "← All projects" link back to the portal (keeps `?admin=1`).
- Per-project email: subject and CSV filename identify Upholstery / Board / DUX.
- Fixed a bug in the `/note` route of Upholstery/Board (undefined `isComplete` variable → 500 error).
