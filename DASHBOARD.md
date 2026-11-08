# Loom dashboard

This copy of the backend ships with the new Loom dashboard in place of the old "team dashboard" page.

- **Where it lives:** `packages/server/src/loom_server/static/` (`index.html`, `app.css`, `app.js`, `assets/`).
  The server already serves this folder at `/`, so no Python changes were made.
- **How to open it:** run `loom dashboard`. It opens the page with a one-time sign-in link.
- **What it uses:** only this backend's API (`/api/team`, `/api/stats`, `/api/audit`, `/api/ask`, `/api/inbox`,
  `/api/projects/...`, `/api/invites`, `/api/devices/.../revoke`) and the live WebSocket at `/api/ws`.

## Preview without a database

`scripts/dashboard-mock.mjs` fakes the same API with made-up sample data (the people and projects in it aren't real):

```
node scripts/dashboard-mock.mjs
```

Open http://localhost:4300/#login=demo. It's for previewing the design only; don't deploy it.

## What changed from the developer's original

| File | Change |
|---|---|
| `static/index.html`, `static/app.js` | Rewritten: Home, Activity, Team, Inbox, per-project pages, invites, ask with sources |
| `static/style.css` | Removed, replaced by `static/app.css` |
| `static/assets/` | Added: Loom logo and favicon |
| `scripts/dashboard-mock.mjs`, `DASHBOARD.md` | Added |

Everything else is the developer's code, unchanged.
