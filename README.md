[README.md](https://github.com/user-attachments/files/34435137/README.md)
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

## Changes compared to the old projects
- API calls now use the project prefix (`/up/api/...`, `/bo/api/...`, `/dux/api/...`).
- Each checklist has an "← All projects" link back to the portal (keeps `?admin=1`).
- Per-project email: subject and CSV filename identify Upholstery / Board / DUX.
- Fixed a bug in the `/note` route of Upholstery/Board (undefined `isComplete` variable → 500 error).
