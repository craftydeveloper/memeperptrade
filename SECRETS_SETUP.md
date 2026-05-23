# Secrets Setup (Safe for GitHub)

This project is configured so private values stay out of GitHub.

## What is already private

- `.env` and `.env.*` are ignored by git.
- `.data/` is ignored by git.

## Local setup

1. Copy `.env.example` to `.env`.
2. Fill only local/private values in `.env`.
3. Start backend as normal.

## Deployment setup (Render/GitHub)

Set env vars in platform secret settings, not in repository files:

- `NODE_ENV=production`
- `PORT` (if needed by platform)
- `ALLOWED_ORIGINS` (production frontend origins only)
- `ALLOW_NULL_ORIGIN=0`
- `MAINNET_PUBLIC=0` (keep mainnet page locked until launch)
- `BIRDEYE_KEY` (server-side only)
- `RPC_URL` (server-side only)
- `ADMIN_WALLET` (wallet allowed to view beta waitlist emails)

## Protecting provider keys

- Never put Birdeye/Helius/QuickNode keys in frontend code or localStorage.
- Keep keys only in backend env vars (`BIRDEYE_KEY`, `RPC_URL`).
- Frontend should call backend endpoints; backend calls providers with server-side secrets.
- Keep `MAINNET_PUBLIC=0` in testnet deployments so users cannot access mainnet page.

## If a secret was accidentally committed

1. Rotate the secret immediately.
2. Remove it from git history.
3. Re-deploy with new secret values in platform settings.

## Rule of thumb

If it is sensitive, it belongs in environment secrets, not committed files.
