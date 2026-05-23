# TBC Checkpoint (2026-03-16)

## Completed

### Mainnet UI fix
- Added TP/SL display under open positions in `index.html`.
- Preserved TP/SL metadata and quantity fields through Drift position sync.
- Added helper styles for TP/SL detail rows.

### Testnet security step 1
- Moved testnet backend session token persistence from localStorage to sessionStorage.
- Added one-time migration from old localStorage token to sessionStorage.
- Kept compatibility behavior for users with existing saved token.

### Testnet security step 2
- Hardened backend CORS in `backend/server.js`.
- Added allowlist support via `ALLOWED_ORIGINS` (or `ALLOWED_ORIGIN`).
- Added production-safe null-origin policy (`ALLOW_NULL_ORIGIN`, default blocked in prod).
- Added Render env placeholders in `render.yaml`:
  - `NODE_ENV=production`
  - `ALLOWED_ORIGINS` (set in dashboard)
  - `ALLOW_NULL_ORIGIN=0`

## Required runtime config
- Set `ALLOWED_ORIGINS` to your real frontend origin(s), e.g.:
  - `https://your-app.onrender.com`
  - Or comma-separated list for multiple trusted domains.

## Notes
- Workspace is not a git repository, so no commit was created.
- All edits are saved directly to files.

## Next suggested steps
1. Reduce backend session TTL (currently 24h) to a lower value.
2. Add lightweight rate limiting for auth/trade/account endpoints.
3. Optional: switch root route to your preferred default page (`/`, `/mainnet`, or landing page).
